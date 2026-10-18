# typed: false
# frozen_string_literal: true

# agent-comms Homebrew formula.
# Self-tap: brew tap qwts/agent-comms https://github.com/qwts/agent-comms
# Then: brew install qwts/agent-comms/agent-comms
#
# The formula installs from the release tag itself, so the tagged commit
# carries the formula that points at that same tag. scripts/release bumps the
# tag and version below together with every other version site.
class AgentComms < Formula
  desc "Harness-independent agent communication for the qwts fleet"
  homepage "https://github.com/qwts/agent-comms"
  url "https://github.com/qwts/agent-comms.git",
      using: :git,
      tag:   "v0.5.4"
  version "0.5.4"
  license :cannot_represent # proprietary; see LICENSE

  depends_on "node"

  def install
    # The Git-based formula source has no expanded archive stamp.
    (buildpath/"RELEASE_COMMIT").write Utils.safe_popen_read("git", "rev-parse", "HEAD").strip + "\n"
    libexec.install "bin", "lib", "skills", "package.json", "RELEASE_COMMIT"
    (bin/"agent-comms").write <<~EOS
      #!/bin/sh
      exec "#{Formula["node"].opt_bin}/node" "#{libexec}/bin/agent-comms.mjs" "$@"
    EOS
  end

  test do
    assert_equal "agent-comms #{version}", shell_output("#{bin}/agent-comms --version").strip
    system bin/"agent-comms", "skill", "list"
    assert_match(/[0-9a-f]{40}/, shell_output("#{bin}/agent-comms skill path"))
  end
end
