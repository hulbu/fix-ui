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

.PHONY: help install build build-bridge build-embed build-extension package check typecheck test e2e run extension-path clean distclean

help:
	@echo "fix-ui"
	@echo
	@echo "  make install          install workspace dependencies (pnpm)"
	@echo "  make build            build everything: bridge, extension, npm tarballs"
	@echo "  make build-bridge     compile the bridge daemon to packages/bridge/dist"
	@echo "  make build-embed      bundle the embed's global script to packages/embed/dist"
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
build: build-bridge build-embed build-extension package
	@echo
	@echo "built:"
	@echo "  bridge     $(BRIDGE)"
	@echo "  extension  $(EXT)"
	@echo "             ^ load THIS directory in chrome://extensions, not extension/dist"
	@echo "  tarballs   $(DIST)"
	@ls -1 $(DIST)/*.tgz 2>/dev/null | sed 's|^|             |'

build-bridge:
	pnpm --filter fixui-bridge build

# The plain-HTML adapter, and what the Vite plugin serves to the browser. The
# npm tarball is wrong without it: an app would ask for a bundle that is not
# in the package.
build-embed:
	pnpm --filter @hulbu/fixui build

build-extension:
	pnpm --filter fix-ui-extension build

# `pnpm pack` rewrites `workspace:*` deps to real versions, so the tarballs
# resolve each other outside the monorepo. They are NOT consumer-ready yet:
# core and embed still export raw .ts (no build, no `types`, no `files`), so
# only a TypeScript-aware bundler can eat them. Fixing that belongs with the
# publishing work — see docs/known-gaps.md "Before publishing".
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
	rm -rf $(DIST) packages/bridge/dist packages/embed/dist extension/dist e2e/fixtures/*.js test-results

distclean: clean
	rm -rf node_modules packages/*/node_modules extension/node_modules e2e/node_modules
