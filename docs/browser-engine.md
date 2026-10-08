# Running the engine on the phone

The decision to host on GitHub Pages and play on a phone forced one real
architectural choice, and it turned out to be the better one anyway.

GitHub Pages serves static files. No Python, no server process. So the search
can't run on a backend — it has to run in the browser. The engine is Rust, so
that means WebAssembly.

Verified, not assumed. Numbers below are measured.

## Does it work

Yes. Two things in the upstream engine had to be patched, both small:

- **Random numbers.** `rand` pulls in `getrandom`, which refuses to build for
  `wasm32-unknown-unknown` unless you explicitly select its browser backend —
  and it needs both a feature flag and a `cfg` flag, which is easy to miss.
- **The clock.** The search loop calls `std::time::Instant::now()`
  unconditionally, including when the search is capped by iteration count rather
  than time. That *compiles* for the browser and then panics the moment it runs,
  which is the worst failure mode. The `web-time` crate is a drop-in replacement
  that reads the page's clock.

Both are applied by `scripts/build_wasm.sh` against a pinned upstream version,
rather than maintained as a fork. Updating is a one-line change to that script.

## Size

| | |
|---|---|
| Unstripped | 11.4 MB |
| Stripped | 712 KB |
| **Over the wire (gzipped)** | **210 KB** |

Debug info is on by default in the upstream release profile and accounts for the
whole difference, so turning it off is most of the win.

## Speed

Measured in headless Chromium, CPU throttled through the DevTools protocol to
stand in for phone hardware. Native, for reference, is ~268k positions/sec.

| | positions/sec | 20k positions | load |
|---|---|---|---|
| Desktop browser | ~200,000 | 164 ms | 50 ms |
| Mid-range phone (4× slower) | ~43,000 | 475 ms | 111 ms |
| Slow phone (8× slower) | ~19,000 | 1.08 s | 82 ms |

WebAssembly costs about 25% against native. That's a good deal.

## The finding that actually matters

**The ranking doesn't change with the budget.** On the test position — Great Tusk
at 72% against a Kingambit, hazards up — Ice Spinner came first at every setting:

| | Ice Spinner | Rapid Spin | Close Combat | Headlong Rush |
|---|---|---|---|---|
| Desktop, 100k | 50.5% | 28.4% | 9.4% | 8.5% |
| Mid phone, 100k | 48.0% | 31.8% | 9.8% | 7.3% |
| Slow phone, 100k | 49.0% | 30.8% | 8.0% | 9.4% |

Same order, near-identical shares. The search converges early, which Laplace also
reported from the other direction — they found extra search time bought them
nothing because the engine had already settled.

So a phone doesn't need desktop compute to get the right answer. It needs enough
to converge, and that's a few tens of thousands of positions, not millions.

## Budget per turn

Working from the slow-phone figure of ~19,000 positions/sec, and wanting the
answer comfortably inside a turn:

- 4 sampled opponent teams × 10,000 positions = 40,000 total ≈ **2 seconds**
- 8 teams × 10,000 = 80,000 ≈ 4 seconds

Four to six teams is the sensible starting point on a phone, with more on a
desktop. Laplace uses eight, but it has a whole machine and no battery to worry
about.

## What this buys

- Static hosting. One URL, nothing to deploy, nothing to keep running.
- Nothing about a battle leaves the device.
- No account, no API key, no rate limit, no cost per turn.
- Works offline once loaded, apart from the live battle itself.
