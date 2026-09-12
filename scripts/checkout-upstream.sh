#!/usr/bin/env bash
# Put the pinned DeepSeek Harness checkout where build-image.sh expects it.
#
# This repo carries no submodules (AGENTS.md), so the harness is a sibling
# checkout that this script creates or verifies from upstream.json:
#
#   UPSTREAM_DIR   where the checkout lives (default: ../deepseek-harness,
#                  i.e. a sibling of this repo)
#
# Idempotent. An existing checkout at the pinned commit is left alone; one at
# another commit is fetched and moved to the pin; anything that is not a git
# checkout of deepseek-harness is refused rather than overwritten.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
upstream="${UPSTREAM_DIR:-$here/../deepseek-harness}"
pin="$here/upstream.json"

read_pin() { node -p "JSON.parse(require('fs').readFileSync('$pin','utf8')).$1"; }
repo="$(read_pin repository)"
tag="$(read_pin tag)"
commit="$(read_pin commit)"

if [ -d "$upstream/.git" ]; then
  origin="$(git -C "$upstream" remote get-url origin 2>/dev/null || true)"
  case "$origin" in
    *deepseek-harness*) ;;
    *)
      echo "checkout-upstream: $upstream is a git checkout of '$origin', not deepseek-harness; refusing to touch it" >&2
      exit 1
      ;;
  esac
  have="$(git -C "$upstream" rev-parse HEAD)"
  if [ "$have" = "$commit" ]; then
    echo "checkout-upstream: $upstream already at $tag ($commit)"
    exit 0
  fi
  echo "checkout-upstream: $upstream is at $have; moving to $tag"
  git -C "$upstream" fetch --depth 1 origin "refs/tags/$tag:refs/tags/$tag"
  git -C "$upstream" checkout -q "$commit"
elif [ -e "$upstream" ]; then
  echo "checkout-upstream: $upstream exists and is not a git checkout; refusing to overwrite it" >&2
  exit 1
else
  echo "checkout-upstream: cloning $repo@$tag into $upstream"
  git clone -q --depth 1 --branch "$tag" "$repo" "$upstream"
fi

have="$(git -C "$upstream" rev-parse HEAD)"
if [ "$have" != "$commit" ]; then
  echo "checkout-upstream: tag $tag resolved to $have, but upstream.json pins $commit. Update the pin deliberately." >&2
  exit 1
fi
echo "checkout-upstream: $upstream at $tag ($commit)"
