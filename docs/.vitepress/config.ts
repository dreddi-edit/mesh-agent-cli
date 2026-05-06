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
        text: 'Getting Started',
        items: [
          { text: 'Command Guide', link: '/mesh-cli-command-guide' },
          { text: 'Installation & Setup', link: '/go-live' },
          { text: 'Self-Hosting', link: '/self-host' },
        ]
      },
      {
        text: 'Core Concepts',
        items: [
          { text: 'Architecture', link: '/core/architecture' },
          { text: 'Verification & Timelines', link: '/core/timelines' },
          { text: 'Semantic RAG', link: '/core/rag' },
        ]
      },
      {
        text: 'Moonshots',
        items: [
          { text: 'Overview', link: '/moonshots/overview' },
          { text: 'Causal Autopsy', link: '/moonshots/autopsy' },
          { text: 'Precrime', link: '/moonshots/precrime' },
        ]
      },
      {
        text: 'Resources',
        items: [
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
