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
      tag:   "v0.5.5"
  version "0.5.5"
  license :cannot_represent # proprietary; see LICENSE

  depends_on "node"

  def install
    # Older release tags predate source-stamp support. Keep their install path.
    if (buildpath/"RELEASE_COMMIT").exist?
      commit = Utils.safe_popen_read("git", "rev-parse", "HEAD").strip
      (buildpath/"RELEASE_COMMIT").atomic_write "#{commit}\n"
      libexec.install "RELEASE_COMMIT"
    end
    libexec.install "bin", "lib", "skills", "package.json"
    (bin/"agent-comms").write <<~EOS
      #!/bin/sh
      exec "#{Formula["node"].opt_bin}/node" "#{libexec}/bin/agent-comms.mjs" "$@"
    EOS
  end

  test do
    assert_equal "agent-comms #{version}", shell_output("#{bin}/agent-comms --version").strip
    system bin/"agent-comms", "skill", "list"
    provenance = JSON.parse(shell_output("#{bin}/agent-comms skill path"))
    if (libexec/"RELEASE_COMMIT").exist?
      assert_match(/\A(?:[0-9a-f]{40}|[0-9a-f]{64})\z/, provenance.fetch("commit"))
      assert_equal (libexec/"RELEASE_COMMIT").read.strip, provenance.fetch("commit")
    else
      assert_nil provenance.fetch("commit")
    end
  end
end
