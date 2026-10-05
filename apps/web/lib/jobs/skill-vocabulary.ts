// Skills the deterministic requirements parser can recognise without a model.
//
// One entry per skill: the name stored on the job first, then any other spelling
// that means the same thing. Matching is whole-token and case-insensitive
// (see lib/jobs/requirements.ts), so "go" never matches inside "good" and "r"
// is only ever written as "R language" here. The list is deliberately the
// unambiguous tools, languages, platforms and methods a posting names; the
// model pass (only when a posting has no requirements section) covers the
// long tail.

const ENTRIES: string[][] = [
  // Languages
  ['JavaScript', 'js'],
  ['TypeScript'],
  ['Python'],
  ['Java'],
  ['Rust'],
  ['C++', 'cpp'],
  ['C#', 'c sharp'],
  ['Ruby'],
  ['PHP'],
  ['Swift'],
  ['Kotlin'],
  ['Scala'],
  ['MATLAB'],
  ['Elixir'],
  ['Erlang'],
  ['Clojure'],
  ['Haskell'],
  ['Dart'],
  ['Lua'],
  ['Perl'],
  ['Bash', 'shell scripting'],
  ['SQL'],
  ['HTML'],
  ['CSS'],
  ['Solidity'],
  // Web and mobile
  ['React', 'react.js', 'reactjs'],
  ['React Native'],
  ['Next.js', 'nextjs'],
  ['Vue', 'vue.js'],
  ['Angular'],
  ['Svelte'],
  ['Node.js', 'nodejs'],
  ['Express'],
  ['NestJS', 'nest.js'],
  ['Django'],
  ['Flask'],
  ['FastAPI'],
  ['Spring Boot'],
  ['Ruby on Rails'],
  ['Laravel'],
  ['.NET', 'dotnet', 'asp.net'],
  ['GraphQL'],
  ['REST', 'restful'],
  ['gRPC'],
  ['Tailwind', 'tailwindcss'],
  ['Redux'],
  ['Webpack'],
  ['iOS'],
  ['Android'],
  ['Flutter'],
  ['SwiftUI'],
  ['Jetpack Compose'],
  // Data and ML
  ['PostgreSQL', 'postgres'],
  ['MySQL'],
  ['MongoDB'],
  ['Redis'],
  ['Elasticsearch'],
  ['DynamoDB'],
  ['Cassandra'],
  ['SQLite'],
  ['Snowflake'],
  ['BigQuery'],
  ['Redshift'],
  ['Databricks'],
  ['Apache Spark', 'pyspark', 'spark sql'],
  ['Kafka', 'apache kafka'],
  ['Airflow', 'apache airflow'],
  ['dbt'],
  ['Hadoop'],
  ['Pandas'],
  ['NumPy'],
  ['scikit-learn', 'sklearn'],
  ['PyTorch'],
  ['TensorFlow'],
  ['Keras'],
  ['LangChain'],
  ['LLMs', 'large language models'],
  ['machine learning'],
  ['deep learning'],
  ['NLP', 'natural language processing'],
  ['computer vision'],
  ['data modeling'],
  ['ETL'],
  ['A/B testing', 'ab testing', 'experimentation'],
  ['statistics', 'statistical analysis'],
  ['Tableau'],
  ['Power BI'],
  ['Looker'],
  ['Excel'],
  // Infrastructure
  ['AWS', 'amazon web services'],
  ['GCP', 'google cloud'],
  ['Azure'],
  ['Kubernetes', 'k8s'],
  ['Docker'],
  ['Terraform'],
  ['Ansible'],
  ['Helm'],
  ['CI/CD', 'continuous integration'],
  ['Jenkins'],
  ['GitHub Actions'],
  ['GitLab CI'],
  ['Linux'],
  ['Nginx'],
  ['Prometheus'],
  ['Grafana'],
  ['Datadog'],
  ['OpenTelemetry'],
  ['serverless'],
  ['microservices'],
  ['distributed systems'],
  ['system design'],
  ['networking', 'tcp/ip'],
  ['observability'],
  // Security and quality
  ['SOC 2', 'soc2'],
  ['ISO 27001'],
  ['penetration testing', 'pentesting'],
  ['OAuth'],
  ['encryption'],
  ['unit testing'],
  ['Jest'],
  ['Cypress'],
  ['Playwright'],
  ['Selenium'],
  ['test automation'],
  // Tools
  ['Git'],
  ['Jira'],
  ['Figma'],
  ['Salesforce'],
  ['HubSpot'],
  ['SAP'],
  ['Workday'],
  ['NetSuite'],
  ['QuickBooks'],
  ['Zendesk'],
  ['Stripe'],
  ['Shopify'],
  ['Segment'],
  ['Amplitude'],
  ['Mixpanel'],
  ['Google Analytics'],
  ['Notion'],
  ['Slack'],
  // Product, design, delivery
  ['Agile'],
  ['Scrum'],
  ['Kanban'],
  ['roadmapping', 'product roadmap'],
  ['user research'],
  ['wireframing'],
  ['prototyping'],
  ['design systems', 'design system'],
  ['UX', 'user experience'],
  ['UI design'],
  ['Adobe Creative Suite', 'photoshop', 'illustrator'],
  ['stakeholder management'],
  ['project management'],
  ['program management'],
  ['product management'],
  ['technical writing'],
  // Go-to-market
  ['SEO'],
  ['SEM'],
  ['content marketing'],
  ['email marketing'],
  ['paid acquisition', 'paid media'],
  ['demand generation'],
  ['account management'],
  ['pipeline management'],
  ['cold outreach', 'outbound prospecting'],
  ['negotiation'],
  ['customer success'],
  ['CRM'],
  ['B2B SaaS', 'saas'],
  ['enterprise sales'],
  // Finance, legal, people, ops
  ['financial modeling'],
  ['FP&A'],
  ['GAAP'],
  ['accounting'],
  ['forecasting'],
  ['budgeting'],
  ['contract negotiation'],
  ['compliance'],
  ['recruiting', 'talent acquisition'],
  ['HRIS'],
  ['supply chain'],
  ['logistics'],
  ['procurement'],
  ['Six Sigma'],
  ['SQL Server'],
  ['Oracle'],
  // Languages people
  ['mentoring'],
  ['technical leadership'],
  ['people management'],
]

export interface SkillMatcher {
  name: string
  re: RegExp
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')
}

/** Whole-token pattern: a skill is not a skill when it sits inside a longer word or a longer name ("Java" in "JavaScript"). */
function patternFor(term: string): string {
  const body = escapeRe(term).replace(/\s+/g, '\\s+')
  return `(?<![A-Za-z0-9+#])${body}(?![A-Za-z0-9+#])`
}

/**
 * Skills whose bare spelling is also an ordinary word. They only count in the
 * capitalisation the product uses ("Spark", "Helm", "REST"); "spark" or "rest"
 * in a sentence is not a skill.
 */
const EXACT_CASE = new Set(['Swift', 'Spring Boot', 'Express', 'Segment', 'Notion', 'Slack', 'Workday', 'Oracle', 'REST', 'Helm', 'Ruby on Rails', 'Excel'])

/**
 * "Go" is the one language that is also a verb. It counts only as "Golang", or
 * as an item in a list of languages ("Python, Go, Rust"), never in "Go to market".
 */
const GO_RE = /(?<![A-Za-z0-9+#])golang(?![A-Za-z0-9+#])|[,/(]\s*Go(?![A-Za-z0-9+#-])|(?<![A-Za-z0-9+#-])Go(?=\s*[,/)])/i
const GO_STRICT = /[,/(]\s*Go(?![A-Za-z0-9+#-])|(?<![A-Za-z0-9+#-])Go(?=\s*[,/)])/

export const SKILL_MATCHERS: readonly SkillMatcher[] = ENTRIES.map(([name, ...aliases]) => {
  const terms = [name, ...aliases].map((t) => t.replace(/ language$/, ''))
  return { name, re: new RegExp(terms.map(patternFor).join('|'), EXACT_CASE.has(name) ? '' : 'i') }
}).filter((m) => m.name !== 'Go' && m.name !== 'C' && m.name !== 'R language')

/** Every vocabulary skill that appears in `text`, in order of first appearance. */
export function findSkills(text: string): string[] {
  const hits: { name: string; at: number }[] = []
  for (const m of SKILL_MATCHERS) {
    const found = m.re.exec(text)
    if (found) hits.push({ name: m.name, at: found.index })
  }
  const go = GO_RE.exec(text)
  if (go && (/golang/i.test(go[0]) || GO_STRICT.test(text))) hits.push({ name: 'Go', at: go.index })
  return hits.sort((a, b) => a.at - b.at).map((h) => h.name)
}
