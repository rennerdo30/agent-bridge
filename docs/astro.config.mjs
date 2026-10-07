import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";
import starlightThemeGalaxy from "starlight-theme-galaxy";

// CI overrides these defaults using actions/configure-pages, like the owner's other sites.
export default defineConfig({
  site: "https://rennerdo30.github.io",
  base: "/agent-bridge",
  integrations: [starlight({
    title: "agent-bridge",
    description: "Messaging, delegation and a local dashboard for coding agents across CLIs and paired PCs.",
    plugins: [starlightThemeGalaxy()],
    logo: { src: "./src/assets/logo.svg", replacesTitle: false },
    favicon: "/favicon.svg",
    customCss: ["./src/styles/custom.css"],
    social: [{ icon: "github", label: "GitHub", href: "https://github.com/rennerdo30/agent-bridge" }],
    editLink: { baseUrl: "https://github.com/rennerdo30/agent-bridge/edit/main/docs/" },
    sidebar: [
    {
        "label": "Overview",
        "slug": "index"
    },
    {
        "label": "Getting started",
        "items": [
            {
                "label": "Install",
                "slug": "getting-started/install"
            },
            {
                "label": "Update",
                "slug": "getting-started/update"
            },
            {
                "label": "First steps",
                "slug": "getting-started/first-steps"
            }
        ]
    },
    {
        "label": "Concepts",
        "items": [
            {
                "label": "Sessions and project groups",
                "slug": "concepts/sessions"
            },
            {
                "label": "Project group routing",
                "slug": "project-groups"
            },
            {
                "label": "Subagents and delegation",
                "slug": "concepts/delegation"
            },
            {
                "label": "Nested delegation",
                "slug": "nested-delegation"
            },
            {
                "label": "Handoff",
                "slug": "subagent-handoff"
            },
            {
                "label": "Messages and waking",
                "slug": "concepts/messages"
            },
            {
                "label": "Notification waits",
                "slug": "message-waits"
            },
            {
                "label": "Owner questions",
                "slug": "concepts/owner-questions"
            },
            {
                "label": "Decisions",
                "slug": "decisions"
            },
            {
                "label": "History and search",
                "slug": "history-search"
            }
        ]
    },
    {
        "label": "Dashboard",
        "items": [
            {
                "label": "Overview",
                "slug": "dashboard"
            },
            {
                "label": "Owner chat",
                "slug": "dashboard-owner-chat"
            },
            {
                "label": "Approvals",
                "slug": "approval-api"
            },
            {
                "label": "Native subagents",
                "slug": "codex-subagents"
            },
            {
                "label": "Transcripts",
                "slug": "transcripts"
            },
            {
                "label": "Job outcomes",
                "slug": "job-outcomes"
            }
        ]
    },
    {
        "label": "Paired PCs",
        "items": [
            {
                "label": "Connect PCs",
                "slug": "paired-pcs"
            },
            {
                "label": "Network and file transfer",
                "slug": "network"
            },
            {
                "label": "Discovery",
                "slug": "network-discovery"
            },
            {
                "label": "Remote jobs",
                "slug": "remote-jobs"
            },
            {
                "label": "Remote dashboard",
                "slug": "remote-dashboard"
            }
        ]
    },
    {
        "label": "Configuration",
        "items": [
            {
                "label": "Settings",
                "slug": "configuration"
            },
            {
                "label": "Delegated access",
                "slug": "delegated-access"
            },
            {
                "label": "Antigravity",
                "slug": "configuration/antigravity"
            },
            {
                "label": "Live plugin updates",
                "slug": "live-plugin-updates"
            }
        ]
    },
    {
        "label": "Data and storage",
        "items": [
            {
                "label": "Storage and recovery",
                "slug": "storage"
            },
            {
                "label": "Retention",
                "slug": "data-retention"
            },
            {
                "label": "Conversation storage",
                "slug": "conversation-storage"
            },
            {
                "label": "Worktree lifecycle",
                "slug": "worktree-lifecycle"
            }
        ]
    },
    {
        "label": "CLI reference",
        "items": [
            {
                "label": "Commands",
                "slug": "reference/cli"
            }
        ]
    },
    {
        "label": "MCP tools reference",
        "items": [
            {
                "label": "All tools",
                "slug": "reference/tools"
            },
            {
                "label": "Security",
                "slug": "reference/security"
            }
        ]
    },
    {
        "label": "Troubleshooting",
        "items": [
            {
                "label": "Common problems",
                "slug": "troubleshooting"
            },
            {
                "label": "Windows devices",
                "slug": "codex-windows-devices"
            },
            {
                "label": "Command lifetime",
                "slug": "command-lifetime"
            }
        ]
    },
    {
        "label": "Design notes",
        "items": [
            {
                "label": "Performance",
                "slug": "performance"
            },
            {
                "label": "Upgrade 0.29.16",
                "slug": "upgrade-0.29.16"
            },
            {
                "label": "Google CLI research",
                "slug": "google-cli-research"
            },
            {
                "label": "Development",
                "slug": "design/development"
            },
            {
                "label": "Documentation conventions",
                "slug": "design/documentation"
            }
        ]
    }
],
  })],
});
