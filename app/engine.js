// Loading and driving the search engine.
//
// The engine is the upstream poke-engine compiled to WebAssembly, so it runs on
// the phone: nothing about a battle leaves the device, there's no server, and
// there's no cost or rate limit per turn. See docs/browser-engine.md for the
// measurements behind the budgets.

let wasm = null;

export class Engine {
  constructor(module) {
    this.module = module;
  }

  /**
   * Load the engine. Safe to call more than once.
   *
   * The path is resolved against the page, not against this module. A bare
   * relative path in a dynamic import resolves against the importing file, so
   * `./engine/...` from here would look inside `app/` and 404.
   */
  static async load(path = './engine/poke_engine_wasm.js') {
    if (!wasm) {
      const resolved = new URL(path, document.baseURI).href;
      const module = await import(resolved);
      await module.default();
      wasm = module;
    }
    return new Engine(wasm);
  }

  /**
   * Search one position.
   *
   * `positions` caps the work by count rather than by clock, so the same
   * position gives the same advice on any device.
   */
  search(state, positions = 12000) {
    const raw = this.module.search(JSON.stringify(state), 0, positions);
    return JSON.parse(raw);
  }

  /** The legal actions, without searching. Used to fill the panel immediately. */
  options(state) {
    return JSON.parse(this.module.options(JSON.stringify(state)));
  }

  /** Check a position is well formed, so failures are loud rather than silent. */
  check(state) {
    return this.module.check(JSON.stringify(state));
  }
}
