# @hulbu/fixui-core

The framework-free engine behind [fix-ui](https://github.com/hulbu/fix-ui): the
element picker, the CSS-selector builder, the console-error buffer, the entry
format and the transport that posts notes to the local daemon.

**This is not the package you install.** Reach for
[`@hulbu/fixui`](https://www.npmjs.com/package/@hulbu/fixui) — the adapters for
Next, Vite, React and plain HTML — or just run:

```sh
npx fixui-bridge init
```

Use `@hulbu/fixui-core` directly only when you are writing your own adapter for
a surface the embed does not cover (that is what the Chrome extension in the
repo does). It touches nothing but the DOM, has no runtime dependencies, and
makes no assumptions about a framework or a build.

Docs and source: <https://github.com/hulbu/fix-ui>

MIT
