import { defineConfig } from 'vitepress'

const base = process.env.READTHEDOCS_VERSION 
  ? `/en/${process.env.READTHEDOCS_VERSION}/`
  : '/'

export default defineConfig({
  title: "Mesh Agent CLI",
  description: "Agentic Operating System",
  base: base,
  cleanUrls: true,
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
