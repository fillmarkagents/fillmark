"""Measure real fills in Robinhood stock token pools against the Chainlink NAV.

Reads Swap events and feed updates over a block window and reports, per pool,
the total cost vs NAV (s), the entry premium (pi) and the price impact (iota)
in bps, split by market session and size bucket. Read-only.

usage: python3 measure_fills.py <rpc_url_file> <days>
"""
import json, sys, time, urllib.request
from bisect import bisect_right
from collections import Counter, defaultdict
from statistics import median, pstdev

SWAP = "0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67"
ANSWER = "0x0559884fd3a460db3073b7fc896cc77986f16e378210ded43186175bf646fc5f"
FEEDS = {
    # ticker: stock token, feed proxy, feed aggregator
    "TSLA": ("0x322f0929c4625ed5bad873c95208d54e1c003b2d", "0x4a1166a659a55625345e9515b32adecea5547c38", "0x7a6b81ba7fbcb90104d8c496158cf383cd7233b1"),
    "NVDA": ("0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec", "0x379ec4f7c378f34a1b47e4f3cbebcbac3e8e9f15", "0xc9d16e4f2569b9e3ea0468fd85844953713dc2a2"),
}
POOLS = [
    # ticker, fee, pool, full table
    ("TSLA", 3000, "0xf4acdaeeb7022862a763c9b1b885e11191c889e3", True),
    ("TSLA", 500, "0xc4f0172d6ac8dd294dd1137d047d5e1893760236", False),
    ("TSLA", 10000, "0xb349fb08c2712f3a70bad40a4d006b68d67e888b", False),
    ("NVDA", 500, "0xd4eb21209c4d6093f80b5b84f5c45cc093ea14a3", True),
    ("NVDA", 100, "0xb75d2d02b0ec3de50d32e40a4f1a8dae8acc4333", False),
    ("NVDA", 3000, "0xb944cec30bd4175855215d767adc81f39e5f7e2b", False),
    ("NVDA", 10000, "0xc277560df3689a401ba7dedd7626168b234ceb5e", False),
]
BUCKETS = [10, 30, 100, 300, 1_000, 3_000, 10_000, 30_000]
STEP = 500_000
TS_EVERY = 10_000
SENDER_SAMPLE = 300

def say(*a):
    print(*a, flush=True)

def rpc(url, calls):
    body = json.dumps([{"jsonrpc": "2.0", "id": i, "method": m, "params": p} for i, (m, p) in enumerate(calls)]).encode()
    for attempt in range(8):
        try:
            req = urllib.request.Request(url, data=body, headers={"content-type": "application/json", "user-agent": "curl/8.5.0"})
            out = json.load(urllib.request.urlopen(req, timeout=120))
            if isinstance(out, dict):
                raise RuntimeError(out.get("error"))
            out.sort(key=lambda x: x["id"])
            for o in out:
                if "error" in o:
                    raise ValueError(o["error"])
            return [o["result"] for o in out]
        except ValueError:
            raise
        except Exception as e:
            err = e
            time.sleep(min(30, 2 ** attempt))
    raise RuntimeError(f"rpc failed: {type(err).__name__}: {err}")

def batched(url, calls, size=50):
    out = []
    for i in range(0, len(calls), size):
        out += rpc(url, calls[i:i + size])
    return out

def logs_range(url, address, topic, a, b):
    try:
        return rpc(url, [("eth_getLogs", [{"address": address, "topics": [topic], "fromBlock": hex(a), "toBlock": hex(b)}])])[0]
    except ValueError:
        if b - a < 1_000:
            raise
        mid = (a + b) // 2
        return logs_range(url, address, topic, a, mid) + logs_range(url, address, topic, mid + 1, b)

def logs(url, address, topic, start, end):
    found = []
    for a in range(start, end + 1, STEP):
        found += logs_range(url, address, topic, a, min(end, a + STEP - 1))
    return found

def signed(word):
    v = int(word, 16)
    return v - (1 << 256) if v >= 1 << 255 else v

def call(url, to, data):
    return rpc(url, [("eth_call", [{"to": to, "data": data}, "latest"])])[0]

class Clock:
    """Block timestamps from samples every TS_EVERY blocks, linearly interpolated."""
    def __init__(self, url, start, end):
        self.blocks = list(range(start, end, TS_EVERY)) + [end]
        res = batched(url, [("eth_getBlockByNumber", [hex(b), False]) for b in self.blocks])
        self.ts = [int(r["timestamp"], 16) for r in res]
    def at(self, block):
        i = min(max(bisect_right(self.blocks, block) - 1, 0), len(self.blocks) - 2)
        b0, b1, t0, t1 = self.blocks[i], self.blocks[i + 1], self.ts[i], self.ts[i + 1]
        return t0 + (t1 - t0) * (block - b0) / (b1 - b0)

def session(ts):
    # US equities, EST (UTC-5) after 1 Nov 2026. Regular 14:30-21:00 UTC, Mon-Fri. Holidays ignored.
    t = time.gmtime(ts)
    mins = t.tm_hour * 60 + t.tm_min
    if t.tm_wday >= 5:
        return "closed"
    return "regular" if 14 * 60 + 30 <= mins < 21 * 60 else "extended"

def bucket(usd):
    return None if usd < BUCKETS[0] else "B%d" % bisect_right(BUCKETS, usd)

def pct(xs, q):
    xs = sorted(xs)
    return xs[min(len(xs) - 1, int(q * len(xs)))] if xs else float("nan")

def main():
    url = open(sys.argv[1]).read().strip()
    days = float(sys.argv[2])
    head = int(rpc(url, [("eth_blockNumber", [])])[0], 16)
    hb = rpc(url, [("eth_getBlockByNumber", [hex(head), False]), ("eth_getBlockByNumber", [hex(head - 100_000), False])])
    spb = (int(hb[0]["timestamp"], 16) - int(hb[1]["timestamp"], 16)) / 100_000
    start = max(1, head - int(days * 86400 / spb))
    feed_start = max(1, start - int(3 * 86400 / spb))
    say(f"window blocks {start}..{head} (~{days} days, {spb:.3f}s/block)")
    say("[1/4] block clock")
    clock = Clock(url, feed_start, head)
    feeds = {}
    say("[2/4] feed updates")
    for tk, (token, proxy, agg) in FEEDS.items():
        live = "0x" + call(url, proxy, "0x245a7bfc")[-40:]
        if live != agg:
            sys.exit(f"{tk}: proxy now points to {live}, expected {agg}")
        ev = sorted((int(l["blockNumber"], 16), int(l["logIndex"], 16), signed(l["topics"][1]) / 1e8, int(l["data"], 16))
                    for l in logs(url, agg, ANSWER, feed_start, head))
        gaps = [b[3] - a[3] for a, b in zip(ev, ev[1:])]
        feeds[tk] = ev
        say(f"  {tk}: {len(ev)} updates since feed_start, gap p50 {pct(gaps, .5):.0f}s p90 {pct(gaps, .9):.0f}s max {max(gaps) if gaps else 0}s")
    for n, (tk, fee, pool, full) in enumerate(POOLS):
        say(f"[3/4] pool {n + 1}/{len(POOLS)} {tk} fee {fee}")
        token = FEEDS[tk][0]
        stock_is_0 = "0x" + call(url, pool, "0x0dfe1681")[-40:] == token
        ev = feeds[tk]
        keys = [(b, i) for b, i, _, _ in ev]
        swaps = sorted(logs(url, pool, SWAP, start, head), key=lambda l: (int(l["blockNumber"], 16), int(l["logIndex"], 16)))
        rows, prev = [], None
        for l in swaps:
            d = l["data"][2:]
            a0, a1 = signed(d[0:64]), signed(d[64:128])
            p_post = (int(d[128:192], 16) / 2 ** 96) ** 2
            p_pre, prev = prev, p_post
            if p_pre is None:
                continue
            blk, li = int(l["blockNumber"], 16), int(l["logIndex"], 16)
            k = bisect_right(keys, (blk, li)) - 1
            if k < 0:
                continue
            nav, upd = ev[k][2], ev[k][3]
            if stock_is_0:
                stock_amt, usdg_amt, spot = a0, a1, p_pre * 1e12
            else:
                usdg_amt, stock_amt, spot = a0, a1, (1e12 / p_pre if p_pre else 0)
            if stock_amt == 0 or usdg_amt == 0 or spot <= 0:
                continue
            sgn = 1 if stock_amt < 0 else -1  # pool pays out stock = buy
            usd = abs(usdg_amt) / 1e6
            fill = usd / (abs(stock_amt) / 1e18)
            t = clock.at(blk)
            rows.append((session(t), bucket(usd), usd, sgn * 1e4 * (fill - nav) / nav, sgn * 1e4 * (spot - nav) / nav,
                         sgn * 1e4 * (fill - spot) / spot, t - upd, l["transactionHash"]))
        notional = sum(r[2] for r in rows)
        say(f"\n== {tk} fee {fee} pool {pool} (stock is token{0 if stock_is_0 else 1})")
        say(f"swaps {len(rows)}, notional ${notional:,.0f}, iota p50 {pct([r[5] for r in rows], .5):.1f} bps")
        if not full or not rows:
            continue
        for s_name in ("regular", "extended", "closed"):
            ages = [r[6] for r in rows if r[0] == s_name]
            if ages:
                say(f"feed age {s_name:8}: n {len(ages)} p50 {pct(ages, .5):.0f}s p90 {pct(ages, .9):.0f}s p99 {pct(ages, .99):.0f}s max {max(ages):.0f}s")
        step = max(1, len(rows) // SENDER_SAMPLE)
        sample = [r[7] for r in rows[::step]][:SENDER_SAMPLE]
        txs = batched(url, [("eth_getTransactionByHash", [h]) for h in sample])
        senders = Counter(t["from"] for t in txs if t)
        top = senders.most_common(3)
        say(f"senders in sample of {len(sample)} swaps: {len(senders)} distinct, top3 share {sum(c for _, c in top) / max(1, len(sample)):.0%}")
        groups = defaultdict(list)
        for r in rows:
            groups[(r[0], r[1])].append(r)
        say(f"{'session':9} {'bucket':6} {'n':>5} {'s p50':>7} {'s sd':>7} {'pi p50':>7} {'io p50':>7} {'io sd':>6} {'io p90':>7}")
        for key in sorted(groups, key=lambda k: (k[0], k[1] or "")):
            g = groups[key]
            if key[1] is None:
                say(f"{key[0]:9} {'<$10':6} {len(g):5}")
                continue
            ss, ps, io = [r[3] for r in g], [r[4] for r in g], [r[5] for r in g]
            say(f"{key[0]:9} {key[1]:6} {len(g):5} {median(ss):7.1f} {pstdev(ss):7.1f} {median(ps):7.1f} {median(io):7.1f} {pstdev(io):6.1f} {pct(io, .9):7.1f}")
    say("\n[4/4] done")

if __name__ == "__main__":
    main()
