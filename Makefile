# fix-ui — build, test and run targets.
#
# Everything here shells out to pnpm; the Makefile exists so you don't have to
# remember which package owns which script. `make` on its own lists the targets.

SHELL := /bin/bash
.DEFAULT_GOAL := help

REPO    := $(shell pwd)
DIST    := $(REPO)/dist
PKG     := $(REPO)/packages/fixui
BRIDGE  := $(PKG)/dist/bridge/cli.js
EXT     := $(REPO)/extension

# Port and project the `run` target uses. Override: make run PORT=4000 PROJECT=~/app
PORT    ?= 3499
PROJECT ?= $(CURDIR)

.PHONY: help install build build-fixui build-extension package check typecheck test e2e run extension-path clean distclean

help:
	@echo "fix-ui"
	@echo
	@echo "  make install          install workspace dependencies (pnpm)"
	@echo "  make build            build everything on the default path: the fixui package, tarball"
	@echo "  make build-fixui      compile fixui to packages/fixui/dist (embed, bridge, global script)"
	@echo "  make build-extension  bundle the Chrome extension into extension/dist"
	@echo "  make package          pack the publishable npm tarball into dist/"
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

# The extension is deliberately NOT built here. It is the adapter for sites you
# do not control, and it is off the default path — `make build-extension` when
# you want it. Its tests still run in `make test`, so it cannot rot unnoticed.
build: build-fixui package
	@echo
	@echo "built:"
	@echo "  fixui      $(PKG)/dist"
	@echo "  bin        $(BRIDGE)"
	@echo "  tarball    $(DIST)"
	@ls -1 $(DIST)/*.tgz 2>/dev/null | sed 's|^|             |'
	@echo
	@echo "  (extension not built — it is off the default path: make build-extension)"

# Three artefacts from one build: the browser half (`dist/core`, `dist/embed` —
# the compiled ESM + declarations every adapter entry point resolves to), the
# node half (`dist/bridge`, whose `cli.js` is the bin), and
# `dist/fixui.global.js`, the IIFE the plain-HTML adapter loads and the Vite
# plugin serves. The npm tarball is wrong without any of them — an app would ask
# for files that are not in the package.
build-fixui:
	pnpm --filter fixui build

build-extension:
	pnpm --filter fix-ui-extension build

# `prepack` rebuilds `dist` first, so a tarball can never be assembled from a
# stale one. One package, so there is no cross-package version pin that could
# point at something a registry has never seen — the failure that made the
# first publish uninstallable.
#
# The result is consumer-ready: compiled ESM behind `exports`, `.d.ts` beside
# it, the `fixui` bin, the shipped skill, and `files` limited to what ships.
package: build-fixui
	@mkdir -p $(DIST)
	@rm -f $(DIST)/*.tgz
	pnpm --filter fixui exec pnpm pack --pack-destination $(DIST)

check: typecheck test e2e

typecheck:
	pnpm -r typecheck

test:
	pnpm -r --filter '!e2e' test

e2e:
	pnpm --filter e2e test

# Runs in the foreground and prints its URL and review token. Ctrl-C to stop.
run: build-fixui
	cd $(PROJECT) && node $(BRIDGE) --port $(PORT)

extension-path:
	@echo "$(EXT)"

clean:
	rm -rf $(DIST) packages/fixui/dist extension/dist e2e/fixtures/*.js test-results

distclean: clean
	rm -rf node_modules packages/*/node_modules extension/node_modules e2e/node_modules
