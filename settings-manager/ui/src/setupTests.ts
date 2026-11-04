import "@testing-library/jest-dom/vitest"

/** jsdom stubs for DOM APIs that Radix primitives and scroll helpers call. */
Element.prototype.scrollTo ??= () => {}
Element.prototype.scrollIntoView ??= () => {}
Element.prototype.hasPointerCapture ??= () => false
Element.prototype.releasePointerCapture ??= () => {}
globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} }
