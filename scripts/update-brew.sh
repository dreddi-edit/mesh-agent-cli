#!/bin/bash
# script/update-brew.sh - Updates the Homebrew formula after a new NPM release

set -e

echo "Fetching latest NPM version..."
VERSION=$(node -p "require('./package.json').version")
TARBALL_URL="https://registry.npmjs.org/@edgarelmo/mesh-agent-cli/-/mesh-agent-cli-${VERSION}.tgz"

echo "Downloading $TARBALL_URL to calculate SHA256..."
SHA256=$(curl -sL "$TARBALL_URL" | shasum -a 256 | awk '{print $1}')

if [ -z "$SHA256" ]; then
  echo "Error: Could not calculate SHA256. Is the package published on NPM?"
  exit 1
fi

echo "Updating Homebrew tap dreddi-edit/homebrew-mesh to version $VERSION ($SHA256)..."

# Download current formula
gh api /repos/dreddi-edit/homebrew-mesh/contents/Formula/mesh-agent-cli.rb > /tmp/formula.json
SHA=$(node -p "require('/tmp/formula.json').sha")

# Generate new formula content
NEW_CONTENT=$(cat <<EOF
require "language/node"

class MeshAgentCli < Formula
  desc "Mesh terminal agent CLI"
  homepage "https://github.com/dreddi-edit/mesh-agent-cli"
  url "$TARBALL_URL"
  sha256 "$SHA256"
  license "MIT"

  depends_on "node"

  def install
    system "npm", "install", *Language::Node.std_npm_install_args(libexec)
    bin.install_symlink Dir["#{libexec}/bin/*"]
  end

  test do
    system "#{bin}/mesh", "--version"
  end
end
EOF
)

# Upload new formula
gh api --method PUT /repos/dreddi-edit/homebrew-mesh/contents/Formula/mesh-agent-cli.rb \
  -F message="chore: update to version $VERSION" \
  -F content="$(echo "$NEW_CONTENT" | base64)" \
  -F sha="$SHA"

echo "Homebrew formula successfully updated! ✅"
