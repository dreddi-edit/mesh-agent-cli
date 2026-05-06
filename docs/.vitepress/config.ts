import { defineConfig } from 'vitepress'

export default defineConfig({
  title: "Mesh Agent CLI",
  description: "Agentic Operating System",
  themeConfig: {
    nav: [
      { text: 'Home', link: '/' },
      { text: 'Guide', link: '/mesh-cli-command-guide' }
    ],
    sidebar: [
      {
        text: 'Documentation',
        items: [
          { text: 'Command Guide', link: '/mesh-cli-command-guide' },
          { text: 'Go Live', link: '/go-live' },
          { text: 'Self-Host', link: '/self-host' },
          { text: 'Support', link: '/support' },
          { text: 'Privacy', link: '/privacy' },
          { text: 'Release Runbook', link: '/release-runbook' },
        ]
      }
    ],
    socialLinks: [
      { icon: 'github', link: 'https://github.com/dreddi-edit/mesh-agent-cli' }
    ]
  }
})
