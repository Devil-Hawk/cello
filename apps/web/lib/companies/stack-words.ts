// The technology words "Named in postings" counts. A posting names a word when it appears as a whole word in its title
// or description. Most match without regard to case; the few below that are also plain English match only as written
// ("Go", "Rust", "Swift", "Spark", "Ruby", "Express", "React", "Rails"), so "ready to go" is not Go, and "Go-to-market"
// is not Go either. "Spring" alone is a season and a benefits vendor, so only "Spring Boot", "Spring Framework" and
// "Spring Cloud" count.
//
// ponytail: a fixed list of about 80 words and no stemming or aliases ("k8s" is not Kubernetes, "golang" is its own
// entry). It names what postings say, not what a team uses. The upgrade is to grow the list from the words postings
// repeat that the list lacks.

const CASED = ['Go', 'Rust', 'Swift', 'Spark', 'Ruby', 'Express', 'React', 'Rails']

const ANY_CASE = [
  // languages
  'Python', 'Java', 'JavaScript', 'TypeScript', 'Golang', 'Kotlin', 'Scala', 'C++', 'C#', 'PHP', 'Elixir', 'Haskell', 'Perl', 'Objective-C', 'Dart', 'SQL', 'Bash',
  // web and mobile
  'Spring Boot', 'Spring Framework', 'Spring Cloud', 'Angular', 'Vue', 'Next.js', 'Node.js', 'Django', 'Flask', 'FastAPI', '.NET', 'GraphQL', 'gRPC', 'Flutter', 'React Native', 'Tailwind',
  // data and ml
  'Kafka', 'Airflow', 'dbt', 'Snowflake', 'BigQuery', 'Databricks', 'Hadoop', 'Flink', 'Pandas', 'NumPy', 'PyTorch', 'TensorFlow', 'scikit-learn', 'Elasticsearch', 'ClickHouse', 'Tableau', 'Looker',
  // stores
  'PostgreSQL', 'MySQL', 'MongoDB', 'Redis', 'DynamoDB', 'Cassandra', 'SQLite', 'Neo4j',
  // infrastructure
  'AWS', 'GCP', 'Azure', 'Kubernetes', 'Docker', 'Terraform', 'Ansible', 'Helm', 'Linux', 'Jenkins', 'GitHub Actions', 'Prometheus', 'Grafana', 'Datadog', 'Istio', 'Nginx', 'RabbitMQ', 'Lambda',
  // ai
  'LLM', 'LangChain', 'OpenAI', 'Hugging Face',
]

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
// whole word: not preceded or followed by a letter, digit, + or #
const word = (terms: string[], flags: string) => new RegExp(`(?<![A-Za-z0-9+#])(${terms.sort((a, b) => b.length - a.length).map(escape).join('|')})(?![A-Za-z0-9+#])`, flags)
const loose = word([...ANY_CASE], 'gi')
const exact = word([...CASED], 'g')
// "Go-to-market", "Go To Market" and "Go to market" are sales talk, not the language
const SALES_GO = /^(?:-to\b|\s+to\s+market)/i
// A capital "Go" that follows a period, exclamation or question mark is the first word of a sentence ("Go beyond."), so it
// does not count. A "Go" at the start of a line, a title or the text still counts ("Go developer", an unbulleted list).
// ponytail: a sentence-opening "Go" that is the language ("Go is our stack.") is missed, and "Go beyond" opening a text counts;
// a language cue next to it would catch both.
const SENTENCE_START = /[.!?]\s*$/
const goCounts = (text: string, at: number) => !SALES_GO.test(text.slice(at + 2)) && !SENTENCE_START.test(text.slice(0, at))
const canonical = new Map(ANY_CASE.map((t) => [t.toLowerCase(), t]))

/** The distinct stack words a posting's title and text name, in their listed spelling. */
export function stackWords(text: string): string[] {
  const found = new Set<string>()
  for (const m of text.matchAll(loose)) found.add(canonical.get(m[1].toLowerCase()) as string)
  for (const m of text.matchAll(exact)) if (m[1] !== 'Go' || goCounts(text, m.index as number)) found.add(m[1])
  return [...found]
}
