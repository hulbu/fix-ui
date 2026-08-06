# fix-ui — build, test and run targets.
#
# Everything here shells out to pnpm; the Makefile exists so you don't have to
# remember which package owns which script. `make` on its own lists the targets.

SHELL := /bin/bash
.DEFAULT_GOAL := help

REPO    := $(shell pwd)
DIST    := $(REPO)/dist
BRIDGE  := $(REPO)/packages/bridge/dist/cli.js
EXT     := $(REPO)/extension

# Port and project the `run` target uses. Override: make run PORT=4000 PROJECT=~/app
PORT    ?= 3499
PROJECT ?= $(CURDIR)

.PHONY: help install build build-bridge build-core build-embed build-extension package check typecheck test e2e run extension-path clean distclean

help:
	@echo "fix-ui"
	@echo
	@echo "  make install          install workspace dependencies (pnpm)"
	@echo "  make build            build everything on the default path: bridge, embed, tarballs"
	@echo "  make build-bridge     compile the bridge daemon to packages/bridge/dist"
	@echo "  make build-core       compile the core engine to packages/core/dist"
	@echo "  make build-embed      compile the embed and its global script to packages/embed/dist"
	@echo "  make build-extension  bundle the Chrome extension into extension/dist"
	@echo "  make package          pack publishable npm tarballs into dist/"
	@echo
	@echo "  make check            the full gate: typecheck + unit/contract + e2e"
	@echo "  make typecheck        tsc across every package"
	@echo "  make test             unit and contract suites"
	@echo "  make e2e              Playwright suite (needs: pnpm --filter e2e exec playwright install chromium)"
	@echo
	@echo "  make run              run the bridge here (PORT=$(PORT), PROJECT=$(PROJECT))"
	@echo "  make extension-path   print the directory to load in chrome://extensions"
	@echo "  make clean            remove build output"
	@echo "  make distclean        clean + remove node_modules"

install:
	pnpm install

# The bridge must be built before the extension: the e2e harness and the
# extension's own build both assume a compiled daemon is available to test against.
# The extension is deliberately NOT built here. It is the adapter for sites you
# do not control, and it is off the default path — `make build-extension` when
# you want it. Its tests still run in `make test`, so it cannot rot unnoticed.
build: build-bridge build-core build-embed package
	@echo
	@echo "built:"
	@echo "  bridge     $(BRIDGE)"
	@echo "  core       $(REPO)/packages/core/dist"
	@echo "  embed      $(REPO)/packages/embed/dist"
	@echo "  tarballs   $(DIST)"
	@ls -1 $(DIST)/*.tgz 2>/dev/null | sed 's|^|             |'
	@echo
	@echo "  (extension not built — it is off the default path: make build-extension)"

build-bridge:
	pnpm --filter fixui-bridge build

build-core:
	pnpm --filter @hulbu/fixui-core build

# Two artefacts from one build: the compiled ESM + declarations every adapter
# entry point resolves to, and `dist/fixui.global.js`, the IIFE the plain-HTML
# adapter loads and the Vite plugin serves. The npm tarball is wrong without
# either — an app would ask for files that are not in the package.
#
# Needs core built first: the embed's `tsc` reads core's emitted `.d.ts`.
build-embed: build-core
	pnpm --filter @hulbu/fixui build

build-extension:
	pnpm --filter fix-ui-extension build

# `pnpm pack` rewrites `workspace:*` deps to real versions, so the tarballs
# resolve each other outside the monorepo, and each package's `prepack` rebuilds
# its own `dist` — a tarball can never be assembled from a stale one.
#
# These are consumer-ready: compiled ESM behind `exports`, `.d.ts` beside it,
# `files` limited to what ships. Publishing them is a human's call — see
# .superpowers/publishable-report.md for the exact commands.
package: build-bridge build-embed
	@mkdir -p $(DIST)
	@rm -f $(DIST)/*.tgz
	pnpm --filter @hulbu/fixui-core exec pnpm pack --pack-destination $(DIST)
	pnpm --filter @hulbu/fixui      exec pnpm pack --pack-destination $(DIST)
	pnpm --filter fixui-bridge      exec pnpm pack --pack-destination $(DIST)

check: typecheck test e2e

typecheck:
	pnpm -r typecheck

test:
	pnpm -r --filter '!e2e' test

e2e:
	pnpm --filter e2e test

# Runs in the foreground and prints its URL and review token. Ctrl-C to stop.
run: build-bridge
	cd $(PROJECT) && node $(BRIDGE) --port $(PORT)

extension-path:
	@echo "$(EXT)"

clean:
	rm -rf $(DIST) packages/bridge/dist packages/core/dist packages/embed/dist extension/dist e2e/fixtures/*.js test-results

distclean: clean
	rm -rf node_modules packages/*/node_modules extension/node_modules e2e/node_modules
