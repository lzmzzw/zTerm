// Author: Liz
Object.defineProperty(window, "__ZTERM_TEST__", {
  value: true,
  configurable: true,
});

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
