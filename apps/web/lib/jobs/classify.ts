// Deterministic, PURE job classifier — no LLM, no network, no DB, no imports.
//
// It must stay dependency-free so the exact same code runs in three places:
//   1. the one-shot backfill script over the existing ~18k rows,
//   2. every ingest path (ATS adapters, aggregators, HTML scraper) at write time,
//   3. unit tests (classify.test.ts).
//
// Same input => same output, forever. When you change the taxonomy or the
// blocklists, bump CLASSIFIER_VERSION so the backfill can re-run only the rows
// that were classified by an older version.

export const CLASSIFIER_VERSION = 1

/** Rows scoring below this are junk (synthesized titles, nav links, city names). */
export const QUALITY_REJECT_THRESHOLD = 30

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type JobFunction =
  | 'engineering'
  | 'data'
  | 'product'
  | 'design'
  | 'sales'
  | 'marketing'
  | 'support'
  | 'operations'
  | 'finance'
  | 'hr'
  | 'legal'
  | 'other'

export type Seniority =
  | 'intern'
  | 'junior'
  | 'mid'
  | 'senior'
  | 'staff'
  | 'principal'
  | 'manager'
  | 'director'
  | 'exec'
  | 'unknown'

export type JobType =
  | 'full-time'
  | 'part-time'
  | 'contract'
  | 'internship'
  | 'temporary'
  | 'unknown'

export type RejectReason =
  | 'empty-title'
  | 'city-name-title'
  | 'bare-department-title'
  | 'nav-link-title'
  | 'url-slug-title'
  | 'single-word-non-role'
  | 'company-name-title'

/** Every valid job_function value, for UI facets and DB validation. */
export const JOB_FUNCTIONS: readonly JobFunction[] = [
  'engineering', 'data', 'product', 'design', 'sales', 'marketing',
  'support', 'operations', 'finance', 'hr', 'legal', 'other',
]

/** Every valid seniority value, ordered junior -> senior. */
export const SENIORITY_LEVELS: readonly Seniority[] = [
  'intern', 'junior', 'mid', 'senior', 'staff', 'principal',
  'manager', 'director', 'exec', 'unknown',
]

export interface ClassifyInput {
  title: string
  description?: string | null
  location?: string | null
  companyName?: string | null
}

export interface Classification {
  jobFunction: JobFunction
  seniority: Seniority
  /** ISO 639-1 code ('en', 'de', 'fr', 'es', 'nl') or 'unknown'. */
  language: string
  /** ISO 3166-1 alpha-2 code, or null when the location is unparseable. */
  country: string | null
  isRemote: boolean
  jobType: JobType
  /** 0-100. Below QUALITY_REJECT_THRESHOLD means junk. */
  qualityScore: number
  /** Only set when the row is junk; explains why. */
  rejectReason?: RejectReason
}

// ---------------------------------------------------------------------------
// Text normalization
// ---------------------------------------------------------------------------

/** Lowercase + strip diacritics (Köln -> koln, Düsseldorf -> dusseldorf). */
function fold(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // combining diacritical marks
    .replace(/\u00df/g, 'ss') // eszett
    .toLowerCase()
}

/** fold() + collapse every non-alphanumeric run to a single space. */
function normalizeText(s: string): string {
  return fold(s).replace(/[^a-z0-9]+/g, ' ').trim()
}

function foldSet(entries: readonly string[]): Set<string> {
  const out = new Set<string>()
  for (const e of entries) {
    const n = normalizeText(e)
    if (n) out.add(n)
  }
  return out
}

// ---------------------------------------------------------------------------
// Blocklists (exported so the ingest agent reuses the exact same lists)
// ---------------------------------------------------------------------------

const CITY_NAMES = [
  // German cities currently polluting the DB (scraper synthesized these from
  // URL path slugs on career-site location filters).
  'Aachen', 'Augsburg', 'Bielefeld', 'Bochum', 'Bonn', 'Berlin', 'Braunschweig',
  'Bremen', 'Chemnitz', 'Cologne', 'Köln', 'Koeln', 'Darmstadt', 'Dortmund',
  'Dresden', 'Duisburg', 'Dusseldorf', 'Düsseldorf', 'Duesseldorf', 'Erfurt',
  'Erlangen', 'Essen', 'Frankfurt', 'Freiburg', 'Gelsenkirchen', 'Göttingen',
  'Halle', 'Hamburg', 'Hanover', 'Hannover', 'Heidelberg', 'Heilbronn', 'Jena',
  'Karlsruhe', 'Kassel', 'Kiel', 'Koblenz', 'Krefeld', 'Leipzig', 'Lübeck',
  'Luebeck', 'Magdeburg', 'Mainz', 'Mannheim', 'Munich', 'München', 'Muenchen',
  'Münster', 'Muenster', 'Munster', 'Mönchengladbach', 'Nuremberg', 'Nürnberg',
  'Nuernberg', 'Oberhausen', 'Offenbach', 'Oldenburg', 'Osnabrück', 'Paderborn',
  'Potsdam', 'Regensburg', 'Rostock', 'Saarbrücken', 'Siegen', 'Solingen',
  'Stuttgart', 'Ulm', 'Aalen', 'Wiesbaden', 'Wolfsburg', 'Wuppertal', 'Würzburg',
  'Wuerzburg', 'Ingolstadt', 'Ludwigshafen', 'Leverkusen', 'Hagen', 'Herne',
  'Reutlingen', 'Fürth', 'Trier', 'Bergisch Gladbach', 'Remscheid', 'Salzgitter',
  'Moers', 'Cottbus', 'Hildesheim', 'Recklinghausen', 'Kaiserslautern',
  // Austria / Switzerland
  'Vienna', 'Wien', 'Graz', 'Linz', 'Salzburg', 'Innsbruck', 'Zurich', 'Zürich',
  'Geneva', 'Genève', 'Basel', 'Bern', 'Lausanne', 'Lugano',
  // UK / Ireland
  'London', 'Manchester', 'Birmingham', 'Leeds', 'Glasgow', 'Edinburgh',
  'Liverpool', 'Bristol', 'Sheffield', 'Cardiff', 'Belfast', 'Nottingham',
  'Newcastle', 'Cambridge', 'Oxford', 'Brighton', 'Reading', 'Dublin', 'Cork',
  'Galway', 'Limerick',
  // Rest of Europe
  'Paris', 'Lyon', 'Marseille', 'Toulouse', 'Bordeaux', 'Lille', 'Nantes',
  'Nice', 'Strasbourg', 'Amsterdam', 'Rotterdam', 'Utrecht', 'Eindhoven',
  'The Hague', 'Den Haag', 'Brussels', 'Bruxelles', 'Antwerp', 'Ghent',
  'Madrid', 'Barcelona', 'Valencia', 'Seville', 'Bilbao', 'Malaga', 'Lisbon',
  'Lisboa', 'Porto', 'Rome', 'Roma', 'Milan', 'Milano', 'Turin', 'Naples',
  'Bologna', 'Florence', 'Warsaw', 'Warszawa', 'Krakow', 'Kraków', 'Wroclaw',
  'Gdansk', 'Poznan', 'Prague', 'Praha', 'Brno', 'Budapest', 'Bucharest',
  'Sofia', 'Athens', 'Stockholm', 'Gothenburg', 'Malmo', 'Malmö', 'Oslo',
  'Bergen', 'Copenhagen', 'København', 'Aarhus', 'Helsinki', 'Espoo', 'Tallinn',
  'Riga', 'Vilnius', 'Zagreb', 'Ljubljana', 'Belgrade', 'Istanbul', 'Ankara',
  // North America
  'New York', 'Brooklyn', 'Los Angeles', 'Chicago', 'Houston', 'Phoenix',
  'Philadelphia', 'San Antonio', 'San Diego', 'Dallas', 'Austin', 'San Jose',
  'San Francisco', 'Seattle', 'Denver', 'Boston', 'Portland', 'Atlanta',
  'Miami', 'Detroit', 'Minneapolis', 'Nashville', 'Charlotte', 'Raleigh',
  'Pittsburgh', 'Baltimore', 'Cleveland', 'Columbus', 'Indianapolis',
  'Milwaukee', 'Sacramento', 'Las Vegas', 'Orlando', 'Tampa', 'Salt Lake City',
  'Kansas City', 'St Louis', 'Cincinnati', 'Oakland', 'Palo Alto',
  'Mountain View', 'Sunnyvale', 'Santa Clara', 'Redmond', 'Bellevue',
  'Arlington', 'Washington', 'Toronto', 'Vancouver', 'Montreal', 'Montréal',
  'Calgary', 'Ottawa', 'Edmonton', 'Winnipeg', 'Quebec', 'Waterloo', 'Halifax',
  'Mexico City', 'Guadalajara', 'Monterrey',
  // Asia-Pacific / other
  'Bangalore', 'Bengaluru', 'Mumbai', 'Delhi', 'New Delhi', 'Hyderabad',
  'Chennai', 'Pune', 'Kolkata', 'Ahmedabad', 'Noida', 'Gurgaon', 'Gurugram',
  'Singapore', 'Tokyo', 'Osaka', 'Kyoto', 'Seoul', 'Beijing', 'Shanghai',
  'Shenzhen', 'Hong Kong', 'Taipei', 'Bangkok', 'Jakarta', 'Manila',
  'Kuala Lumpur', 'Ho Chi Minh City', 'Hanoi', 'Sydney', 'Melbourne',
  'Brisbane', 'Perth', 'Adelaide', 'Canberra', 'Auckland', 'Wellington',
  'Dubai', 'Abu Dhabi', 'Doha', 'Riyadh', 'Tel Aviv', 'Jerusalem', 'Haifa',
  'Cairo', 'Nairobi', 'Lagos', 'Johannesburg', 'Cape Town', 'Sao Paulo',
  'São Paulo', 'Rio de Janeiro', 'Buenos Aires', 'Santiago', 'Bogota',
  'Bogotá', 'Lima', 'Montevideo',
]

/**
 * City names that must never stand alone as a job title.
 * Normalized (lowercased, diacritics folded, punctuation stripped).
 */
export const CITY_BLOCKLIST: ReadonlySet<string> = foldSet(CITY_NAMES)

const DEPARTMENT_WORDS = [
  // Bare tech / department words the scraper lifted from nav menus.
  'Backend', 'Back end', 'Frontend', 'Front end', 'Fullstack', 'Full stack',
  'Android', 'iOS', 'Mobile', 'Web', 'DevOps', 'SRE', 'QA', 'Testing',
  'Infrastructure', 'Platform', 'Security', 'Cloud', 'Data', 'AI', 'ML',
  'Machine Learning', 'Analytics', 'Engineering', 'Development', 'Software',
  'Technology', 'Tech', 'IT', 'Design', 'UX', 'UI', 'Product', 'Marketing',
  'Sales', 'Finance', 'Accounting', 'Legal', 'HR', 'People', 'Operations',
  'Ops', 'Support', 'Customer Success', 'Research', 'Consulting', 'Admin',
  'Administration', 'General', 'Other', 'Various', 'Misc',
  // Nav / boilerplate words (EN + DE).
  'Jobs', 'Job', 'Career', 'Careers', 'Karriere', 'Stellenangebote',
  'Stellenangebot', 'Stellen', 'Bewerbung', 'Bewerben', 'Vacancies', 'Vacancy',
  'Openings', 'Opening', 'Positions', 'Position', 'Roles', 'Role', 'Apply',
  'Home', 'About', 'Contact', 'Impressum', 'Datenschutz', 'Login', 'Search',
  'More', 'All', 'View', 'Details', 'Overview', 'Team', 'Teams', 'Company',
  'Standorte', 'Standort', 'Unternehmen', 'Kontakt', 'Ueber uns', 'Über uns',
]

/**
 * Words that are a department/tech/nav label, never a real role, when they are
 * the entire title. "Backend" is junk; "Backend Engineer" is not.
 */
export const DEPARTMENT_BLOCKLIST: ReadonlySet<string> = foldSet(DEPARTMENT_WORDS)

/**
 * The pure navigation/boilerplate subset of DEPARTMENT_BLOCKLIST. A title made
 * entirely of department words is only rejected when one of them is a nav word,
 * so "Marketing Jobs" is junk while "Product Design" survives.
 */
export const NAV_WORDS: ReadonlySet<string> = foldSet([
  'Jobs', 'Job', 'Career', 'Careers', 'Karriere', 'Stellenangebote',
  'Stellenangebot', 'Stellen', 'Bewerbung', 'Bewerben', 'Vacancies', 'Vacancy',
  'Openings', 'Opening', 'Positions', 'Position', 'Roles', 'Role', 'Apply',
  'Home', 'About', 'Contact', 'Impressum', 'Datenschutz', 'Login', 'Search',
  'More', 'All', 'View', 'Details', 'Overview', 'Standorte', 'Standort',
])

const NAV_PHRASES = [
  'View Job', 'View Jobs', 'View Details', 'View All', 'View All Jobs',
  'See Jobs', 'See All Jobs', 'See Openings', 'Show Jobs', 'Browse Jobs',
  'Apply Now', 'Apply Here', 'Apply Today', 'Learn More', 'Read More',
  'Find Out More', 'Back to Jobs', 'All Jobs', 'All Openings', 'All Positions',
  'Open Positions', 'Open Roles', 'Open Jobs', 'Current Openings',
  'Job Search', 'Job Board', 'Job Alerts', 'Search Jobs', 'Join Us',
  'Join Our Team', 'Work With Us', 'Work Here', 'Life At', 'Our Team',
  'Alle Jobs', 'Alle Stellen', 'Offene Stellen', 'Jetzt Bewerben',
  'Mehr Erfahren', 'Zur Stellenanzeige', 'Stellenangebote Suchen',
  'General Application', 'Speculative Application', 'Talent Pool',
  'Initiativbewerbung', 'Talent Community', 'Future Opportunities',
  'No Results', 'Not Found', 'Coming Soon', 'Untitled', 'New Job',
  'Open Job', 'Open Jobs', 'Open Role', 'See Job', 'See Jobs', 'See Role',
  'Join Now', 'Job Advertising', 'Job Guides', 'Early Careers', 'Benefits',
  'Culture', 'Locations', 'Categories', 'University', 'Recruitment Fraud',
  'Google Review', 'Free Job Posting', 'Jobs by Locations', 'Jobs with Salary',
]

/** Multi-word nav/boilerplate phrases that are never a real job title. */
export const NAV_PHRASE_BLOCKLIST: ReadonlySet<string> = foldSet(NAV_PHRASES)

const ROLE_NOUN_WORDS = [
  'engineer', 'engineering', 'developer', 'programmer', 'architect', 'designer',
  'scientist', 'analyst', 'manager', 'director', 'lead', 'head', 'chief',
  'president', 'founder', 'partner', 'officer', 'executive', 'principal',
  'fellow', 'consultant', 'advisor', 'adviser', 'specialist', 'coordinator',
  'associate', 'administrator', 'assistant', 'technician', 'operator',
  'supervisor', 'representative', 'recruiter', 'sourcer', 'generalist',
  'accountant', 'controller', 'auditor', 'bookkeeper', 'counsel', 'attorney',
  'lawyer', 'paralegal', 'nurse', 'physician', 'doctor', 'surgeon', 'dentist',
  'pharmacist', 'therapist', 'paramedic', 'veterinarian', 'receptionist',
  'strategist', 'researcher', 'writer', 'copywriter', 'editor', 'journalist',
  'marketer', 'seller', 'buyer', 'planner', 'trainer', 'instructor', 'teacher',
  'professor', 'tutor', 'coach', 'chef', 'cook', 'baker', 'barista', 'driver',
  'mechanic', 'electrician', 'plumber', 'welder', 'machinist', 'carpenter',
  'technologist', 'tester', 'evangelist', 'advocate', 'ambassador',
  'intern', 'apprentice', 'trainee', 'clerk', 'cashier', 'dispatcher',
  'estimator', 'inspector', 'interpreter', 'translator', 'librarian',
  'scheduler', 'underwriter', 'actuary', 'economist', 'statistician',
  'sdr', 'bdr', 'ae', 'csm', 'pm', 'swe', 'dba', 'qa',
  'entwickler', 'ingenieur', 'berater', 'mitarbeiter', 'werkstudent',
  'sachbearbeiter', 'referent', 'techniker', 'kaufmann', 'kauffrau',
  'fachkraft', 'lokfuhrer', 'praktikant', 'auszubildende',
]

/** Single words that are legitimately a whole job title ("Recruiter"). */
export const ROLE_NOUNS: ReadonlySet<string> = new Set(ROLE_NOUN_WORDS.map(fold))

/** Suffixes that mark an unfamiliar single word as an agent noun / role. */
const ROLE_SUFFIX_RE = /(er|or|ist|ian|ant|ent|eer|ess|yst|ologist|ician|smith|wright|keeper|master)$/

/**
 * Link text lifted from aggregator nav menus: an imperative/plural opener
 * followed by a jobs-domain noun. Catches "Jobs with Relocation Package",
 * "Companies Hiring in Germany", "Free Job Posting", "Browse Jobs".
 * Deliberately requires BOTH halves so "Open Source Engineer" and
 * "Search Quality Rater" survive.
 */
const NAV_PATTERN_RE =
  /^(jobs?|karriere|stellenangebote|companies|free|find|browse|search|explore|discover|join|apply|view|see|show|learn|read|open|back to)\b.*\b(jobs?|hiring|posting|positions?|roles?|openings?|salary|locations?|package|board|more|us|now|here)\b$/

/**
 * Nav link text identified by its opening phrase alone, regardless of the tail
 * ("Companies Hiring in Germany", "Jobs with Relocation Package"). Kept as an
 * explicit prefix list rather than loosening NAV_PATTERN_RE, which would start
 * eating real titles that merely contain the word "jobs".
 */
const NAV_PREFIX_RE =
  /^(companies hiring|jobs (with|by|in|for|near|at)|free job|find jobs?|browse jobs?|search jobs?|explore open|see open|view open|all open|current open|our open)\b/

/** Sentence-shaped "we have nothing open" links. */
const NAV_SENTENCE_RE = /\b(don t see|dont see|didn t see|can t find|cant find|cannot find)\b/

/** Country / region tokens to ignore when testing "is this title only a city?". */
const GEO_QUALIFIER_TOKENS = new Set([
  'usa', 'us', 'uk', 'gb', 'de', 'ca', 'ie', 'fr', 'nl', 'at', 'ch', 'in',
  'germany', 'deutschland', 'england', 'scotland', 'ireland', 'france',
  'canada', 'india', 'austria', 'switzerland', 'netherlands', 'spain', 'italy',
  'on', 'qc', 'bc', 'ny', 'nyc', 'ca', 'tx', 'wa', 'ma', 'il', 'dc',
])

/** Filler words ignored when deciding whether a title is "only" cities/departments. */
const TITLE_STOPWORDS = new Set([
  'in', 'at', 'the', 'a', 'an', 'and', 'or', 'of', 'for', 'to', 'de', 'la',
  'und', 'der', 'die', 'das', 'im', 'am', 'fur', 'bei', 'von', 'zu',
])

// ---------------------------------------------------------------------------
// Job function taxonomy
// ---------------------------------------------------------------------------

/**
 * Ordered phrase -> function rules. FIRST MATCH WINS, so multi-word and
 * cross-cutting phrases ("data engineer", "product designer") must come before
 * the generic single words ("engineer", "product").
 */
const FUNCTION_RULES: ReadonlyArray<[readonly string[], JobFunction]> = [
  // Data (before engineering: "Data Engineer" is data, not engineering)
  [['data scientist', 'data engineer', 'data analyst', 'analytics engineer',
    'machine learning', 'ml engineer', 'mlops', 'ai engineer', 'ai researcher',
    'research scientist', 'applied scientist', 'data science', 'bi developer',
    'business intelligence', 'data architect', 'data engineering',
    'quantitative', 'nlp engineer', 'computer vision', 'deep learning',
    'data steward', 'data governance'], 'data'],

  // Design (before product/engineering: "Product Designer" is design)
  [['product designer', 'ux designer', 'ui designer', 'ux researcher',
    'ux writer', 'visual designer', 'graphic designer', 'brand designer',
    'motion designer', 'interaction designer', 'design lead', 'design manager',
    'design engineer', 'creative director', 'art director', 'illustrator',
    'presentation designer', 'design system', 'user experience',
    'user research', 'industrial designer', 'freelance designer',
    'instructional designer', 'designer'], 'design'],

  // Marketing (before product: "Product Marketing Manager" is marketing)
  [['product marketing', 'growth marketing', 'content marketing',
    'field marketing', 'brand marketing', 'performance marketing',
    'lifecycle marketing', 'demand generation', 'demand gen', 'seo',
    'sem specialist', 'social media', 'communications', 'public relations',
    'copywriter', 'content strategist', 'content manager', 'campaign',
    'marketing', 'growth manager', 'growth lead', 'creative strategist',
    'community manager', 'events manager', 'webinar', 'content writer',
    'technical writer', 'writer', 'content'], 'marketing'],

  // Sales
  [['account executive', 'account manager', 'sales engineer', 'sales manager',
    'sales development', 'sdr', 'bdr', 'business development', 'pre sales',
    'presales', 'solutions consultant', 'sales operations', 'revenue operations',
    'revops', 'partnerships', 'channel manager', 'enterprise sales',
    'inside sales', 'field sales', 'sales', 'vertrieb', 'commercial terrain',
    'go to market', 'market manager', 'startups ambassador'], 'sales'],

  // Support / customer
  [['customer success', 'customer support', 'customer experience',
    'technical support', 'support engineer', 'support specialist',
    'help desk', 'helpdesk', 'service desk', 'customer service',
    'client services', 'implementation manager', 'onboarding specialist',
    'renewals', 'technical account manager'], 'support'],

  // HR / people
  [['recruiter', 'recruiting', 'technical sourcer', 'sourcer', 'talent acquisition',
    'talent partner', 'people operations', 'people partner', 'people consultant',
    'hr generalist', 'hr business partner', 'hrbp', 'human resources',
    'compensation', 'benefits manager', 'learning and development',
    'people team', 'personalreferent', 'talent manager'], 'hr'],

  // Legal
  [['counsel', 'attorney', 'lawyer', 'paralegal', 'legal', 'compliance officer',
    'privacy officer', 'contracts manager', 'litigation', 'justiziar'], 'legal'],

  // Finance
  [['accountant', 'accounting', 'controller', 'financial analyst', 'fp a',
    'finance manager', 'finance associate', 'finance director', 'treasury',
    'payroll', 'bookkeeper', 'auditor', 'tax manager', 'billing',
    'strategic finance', 'investor relations', 'corporate development',
    'financial reporting', 'credit risk', 'tax', 'accounts payable',
    'accounts receivable', 'underwriter', 'finance', 'buchhalter'], 'finance'],

  // Product
  [['product manager', 'product owner', 'product lead', 'product operations',
    'technical product', 'group product', 'product analyst', 'product strategy',
    'produktmanager'], 'product'],

  // Engineering (generic, after the specific carve-outs above)
  [['software engineer', 'software developer', 'backend engineer',
    'frontend engineer', 'full stack', 'fullstack', 'web developer',
    'mobile engineer', 'ios engineer', 'android engineer', 'devops',
    'site reliability', 'sre', 'platform engineer', 'infrastructure engineer',
    'security engineer', 'network engineer', 'systems engineer',
    'cloud engineer', 'qa engineer', 'quality assurance', 'sdet',
    'test engineer', 'firmware', 'embedded', 'hardware engineer',
    'solutions architect', 'solution architect', 'technical architect',
    'solutions engineer', 'solution engineer', 'forward deployed',
    'deployment strategist', 'engineering manager', 'engineer', 'engineers',
    'engineering', 'developer', 'developers', 'entwickler', 'programmer',
    'architect', 'softwareentwicklung', 'technical lead', 'tech lead',
    'cto', 'chief technology'], 'engineering'],

  // Operations (last catch-all before 'other')
  [['program manager', 'project manager', 'project coordinator',
    'operations manager', 'operations analyst', 'business operations',
    'chief of staff', 'executive assistant', 'office manager',
    'office assistant', 'administrative assistant', 'receptionist',
    'supply chain', 'logistics', 'procurement', 'facilities', 'workplace',
    'operations', 'strategy manager', 'business analyst', 'engagement manager',
    'safety specialist', 'workday specialist', 'operations lead',
    // Generic role nouns — LAST resort, only reached when every specific rule
    // above missed. Better than dumping every "Manager, <business thing>" into
    // 'other'.
    'consultant', 'analyst', 'manager', 'director', 'specialist',
    'coordinator', 'advisor', 'associate', 'lead'], 'operations'],
]

// ---------------------------------------------------------------------------
// Seniority
// ---------------------------------------------------------------------------

/** Ordered: first match wins, most-specific band first. */
const SENIORITY_RULES: ReadonlyArray<[RegExp, Seniority]> = [
  [/\b(intern|internship|praktikum|praktikant(in)?|werkstudent(in)?|working student|apprentice|ausbildung|auszubildende|co op|student assistant)\b/, 'intern'],
  [/\b(chief|c level|cto|ceo|cfo|coo|cpo|cro|cmo|ciso|cio|vp|svp|evp|vice president|president|general manager|geschaftsfuhrer|managing director)\b/, 'exec'],
  [/\b(director|head of|bereichsleiter|abteilungsleiter)\b/, 'director'],
  [/\b(principal|distinguished|fellow)\b/, 'principal'],
  [/\b(staff)\b/, 'staff'],
  [/\b(manager|supervisor|team lead|tech lead|technical lead|teamleiter|leiter|squad lead|group lead)\b/, 'manager'],
  [/(\blead\b)$/, 'manager'],
  [/\b(senior|sr|snr|iii|iv|expert|experienced)\b/, 'senior'],
  [/\b(junior|jr|entry level|graduate|new grad|berufseinsteiger|einsteiger|associate|assistant)\b/, 'junior'],
  [/\b(mid level|midlevel|ii|intermediate)\b/, 'mid'],
]

// ---------------------------------------------------------------------------
// Language detection
// ---------------------------------------------------------------------------

const GERMAN_WORD_RE = new RegExp(
  '\\b(' + [
    'entwickler', 'entwicklerin', 'mitarbeiter', 'mitarbeiterin', 'stellenangebot',
    'stellenangebote', 'stellenanzeige', 'bewerbung', 'bewerben', 'karriere',
    'vertrieb', 'ingenieur', 'kaufmann', 'kauffrau', 'fachkraft', 'werkstudent',
    'ausbildung', 'auszubildende', 'praktikum', 'praktikant', 'unbefristet',
    'befristet', 'festanstellung', 'teilzeit', 'vollzeit', 'gehalt', 'arbeitszeit',
    'betreuung', 'leitung', 'referent', 'sachbearbeiter', 'techniker', 'berater',
    'geschaftsfuhrer', 'softwareentwicklung', 'zugchef', 'lokfuhrer',
    'unternehmen', 'standort', 'aufgaben', 'kenntnisse', 'erfahrung',
    'abgeschlossenes', 'studium', 'suchen', 'unser', 'unsere', 'deine',
    'sowie', 'sind', 'werden', 'kunden', 'projekte', 'teamleiter',
    'buchhalter', 'einsatzort', 'stellenbeschreibung', 'anforderungen',
  ].join('|') + ')\\b'
)

// Short function words are only counted from longer bodies of text (a title is
// too short for them to be reliable evidence).
const GERMAN_STOPWORD_RE = /\b(und|der|die|das|den|dem|des|ein|eine|einen|einem|einer|fur|mit|bei|von|zu|im|am|auf|aus|nicht|sich|auch|oder|als|wie|nach|uber|durch|zum|zur)\b/g

const FRENCH_WORD_RE = /\b(nous|vous|votre|notre|recherchons|poste|entreprise|developpeur|ingenieur|charge|responsable|stage|alternance|salarie|competences|independant|freelance et)\b/
const SPANISH_WORD_RE = /\b(nosotros|buscamos|empresa|puesto|desarrollador|ingeniero|responsable|experiencia|conocimientos|trabajo|equipo|para|con)\b/
const DUTCH_WORD_RE = /\b(wij|zoeken|jouw|onze|ervaring|functie|werken|vacature|ontwikkelaar|medewerker)\b/

// ---------------------------------------------------------------------------
// Geography
// ---------------------------------------------------------------------------

/** Country names / aliases -> ISO 3166-1 alpha-2. Longest phrases first at use. */
const COUNTRY_ALIASES: ReadonlyArray<[string, string]> = [
  ['united states of america', 'US'], ['united states', 'US'], ['usa', 'US'],
  ['u s a', 'US'], ['america', 'US'],
  ['united kingdom', 'GB'], ['great britain', 'GB'], ['england', 'GB'],
  ['scotland', 'GB'], ['wales', 'GB'], ['northern ireland', 'GB'], ['uk', 'GB'],
  ['republic of ireland', 'IE'], ['ireland', 'IE'], ['eire', 'IE'],
  ['deutschland', 'DE'], ['germany', 'DE'],
  ['osterreich', 'AT'], ['austria', 'AT'],
  ['schweiz', 'CH'], ['switzerland', 'CH'], ['suisse', 'CH'],
  ['canada', 'CA'], ['kanada', 'CA'],
  ['india', 'IN'], ['bharat', 'IN'],
  ['france', 'FR'], ['netherlands', 'NL'], ['nederland', 'NL'], ['holland', 'NL'],
  ['belgium', 'BE'], ['belgie', 'BE'], ['belgique', 'BE'],
  ['spain', 'ES'], ['espana', 'ES'], ['portugal', 'PT'], ['italy', 'IT'],
  ['italia', 'IT'], ['poland', 'PL'], ['polska', 'PL'],
  ['czech republic', 'CZ'], ['czechia', 'CZ'], ['sweden', 'SE'],
  ['norway', 'NO'], ['denmark', 'DK'], ['finland', 'FI'], ['iceland', 'IS'],
  ['estonia', 'EE'], ['latvia', 'LV'], ['lithuania', 'LT'], ['romania', 'RO'],
  ['bulgaria', 'BG'], ['greece', 'GR'], ['hungary', 'HU'], ['croatia', 'HR'],
  ['serbia', 'RS'], ['slovenia', 'SI'], ['slovakia', 'SK'], ['ukraine', 'UA'],
  ['turkey', 'TR'], ['turkiye', 'TR'], ['israel', 'IL'],
  ['united arab emirates', 'AE'], ['uae', 'AE'], ['saudi arabia', 'SA'],
  ['qatar', 'QA'], ['egypt', 'EG'], ['nigeria', 'NG'], ['kenya', 'KE'],
  ['south africa', 'ZA'], ['australia', 'AU'], ['new zealand', 'NZ'],
  ['singapore', 'SG'], ['japan', 'JP'], ['south korea', 'KR'], ['korea', 'KR'],
  ['china', 'CN'], ['hong kong', 'HK'], ['taiwan', 'TW'], ['thailand', 'TH'],
  ['vietnam', 'VN'], ['indonesia', 'ID'], ['malaysia', 'MY'],
  ['philippines', 'PH'], ['mexico', 'MX'], ['brazil', 'BR'], ['brasil', 'BR'],
  ['argentina', 'AR'], ['chile', 'CL'], ['colombia', 'CO'], ['peru', 'PE'],
  ['uruguay', 'UY'], ['costa rica', 'CR'],
]

const US_STATE_NAMES = [
  'alabama', 'alaska', 'arizona', 'arkansas', 'california', 'colorado',
  'connecticut', 'delaware', 'florida', 'georgia', 'hawaii', 'idaho',
  'illinois', 'indiana', 'iowa', 'kansas', 'kentucky', 'louisiana', 'maine',
  'maryland', 'massachusetts', 'michigan', 'minnesota', 'mississippi',
  'missouri', 'montana', 'nebraska', 'nevada', 'new hampshire', 'new jersey',
  'new mexico', 'new york', 'north carolina', 'north dakota', 'ohio',
  'oklahoma', 'oregon', 'pennsylvania', 'rhode island', 'south carolina',
  'south dakota', 'tennessee', 'texas', 'utah', 'vermont', 'virginia',
  'washington', 'west virginia', 'wisconsin', 'wyoming',
  'district of columbia', 'washington dc', 'puerto rico',
]

const US_STATE_CODES = new Set([
  'al', 'ak', 'az', 'ar', 'ca', 'co', 'ct', 'dc', 'de', 'fl', 'ga', 'hi', 'ia',
  'id', 'il', 'in', 'ks', 'ky', 'la', 'ma', 'md', 'me', 'mi', 'mn', 'mo', 'ms',
  'mt', 'nc', 'nd', 'ne', 'nh', 'nj', 'nm', 'nv', 'ny', 'oh', 'ok', 'or', 'pa',
  'pr', 'ri', 'sc', 'sd', 'tn', 'tx', 'ut', 'va', 'vt', 'wa', 'wi', 'wv', 'wy',
])

const CA_PROVINCE_CODES = new Set([
  'ab', 'bc', 'mb', 'nb', 'nl', 'ns', 'nt', 'nu', 'on', 'pe', 'qc', 'sk', 'yt',
])

/** 2-letter ISO country codes we accept as an explicit trailing token. */
const ISO_COUNTRY_CODES = new Set([
  'us', 'gb', 'ie', 'de', 'at', 'ch', 'ca', 'in', 'fr', 'nl', 'be', 'es', 'pt',
  'it', 'pl', 'cz', 'se', 'no', 'dk', 'fi', 'is', 'ee', 'lv', 'lt', 'ro', 'bg',
  'gr', 'hu', 'hr', 'rs', 'si', 'sk', 'ua', 'tr', 'il', 'ae', 'sa', 'qa', 'eg',
  'ng', 'ke', 'za', 'au', 'nz', 'sg', 'jp', 'kr', 'cn', 'hk', 'tw', 'th', 'vn',
  'id', 'my', 'ph', 'mx', 'br', 'ar', 'cl', 'co', 'pe', 'uy', 'cr',
])

/** Codes that mean a US state and nothing else in our country set. */
const UNAMBIGUOUS_US_STATE_CODES = new Set(
  Array.from(US_STATE_CODES).filter((c) => !ISO_COUNTRY_CODES.has(c))
)

/** Well-known city -> country, used when no explicit country token is present. */
const CITY_COUNTRY: ReadonlyArray<[string, string]> = [
  // DE
  ...['berlin', 'munich', 'munchen', 'muenchen', 'hamburg', 'frankfurt',
      'cologne', 'koln', 'koeln', 'stuttgart', 'dusseldorf', 'duesseldorf',
      'leipzig', 'dresden', 'hannover', 'hanover', 'nuremberg', 'nurnberg',
      'nuernberg', 'bremen', 'essen', 'dortmund', 'bonn', 'mannheim',
      'karlsruhe', 'freiburg', 'aachen', 'bielefeld', 'bochum', 'augsburg',
      'potsdam', 'wiesbaden', 'munster', 'muenster', 'kiel', 'rostock', 'jena',
      'ulm', 'aalen', 'heidelberg', 'darmstadt', 'mainz', 'kassel',
      'braunschweig', 'duisburg', 'wuppertal', 'regensburg', 'erlangen',
     ].map((c) => [c, 'DE'] as [string, string]),
  // AT / CH
  ...['vienna', 'wien', 'graz', 'linz', 'salzburg', 'innsbruck'].map((c) => [c, 'AT'] as [string, string]),
  ...['zurich', 'geneva', 'basel', 'bern', 'lausanne', 'lugano'].map((c) => [c, 'CH'] as [string, string]),
  // GB / IE
  ...['london', 'manchester', 'birmingham', 'leeds', 'glasgow', 'edinburgh',
      'liverpool', 'bristol', 'sheffield', 'cardiff', 'belfast', 'nottingham',
      'newcastle', 'cambridge', 'oxford', 'brighton', 'reading',
     ].map((c) => [c, 'GB'] as [string, string]),
  ...['dublin', 'cork', 'galway', 'limerick'].map((c) => [c, 'IE'] as [string, string]),
  // Rest of Europe
  ...['paris', 'lyon', 'marseille', 'toulouse', 'bordeaux', 'lille', 'nantes', 'strasbourg'].map((c) => [c, 'FR'] as [string, string]),
  ...['amsterdam', 'rotterdam', 'utrecht', 'eindhoven', 'the hague', 'den haag'].map((c) => [c, 'NL'] as [string, string]),
  ...['brussels', 'bruxelles', 'antwerp', 'ghent'].map((c) => [c, 'BE'] as [string, string]),
  ...['madrid', 'barcelona', 'valencia', 'seville', 'bilbao', 'malaga'].map((c) => [c, 'ES'] as [string, string]),
  ...['lisbon', 'lisboa', 'porto'].map((c) => [c, 'PT'] as [string, string]),
  ...['rome', 'roma', 'milan', 'milano', 'turin', 'naples', 'bologna', 'florence'].map((c) => [c, 'IT'] as [string, string]),
  ...['warsaw', 'warszawa', 'krakow', 'wroclaw', 'gdansk', 'poznan'].map((c) => [c, 'PL'] as [string, string]),
  ...['prague', 'praha', 'brno'].map((c) => [c, 'CZ'] as [string, string]),
  ...['stockholm', 'gothenburg', 'malmo'].map((c) => [c, 'SE'] as [string, string]),
  ...['oslo', 'bergen'].map((c) => [c, 'NO'] as [string, string]),
  ...['copenhagen', 'kobenhavn', 'aarhus'].map((c) => [c, 'DK'] as [string, string]),
  ...['helsinki', 'espoo'].map((c) => [c, 'FI'] as [string, string]),
  ...['budapest'].map((c) => [c, 'HU'] as [string, string]),
  ...['bucharest'].map((c) => [c, 'RO'] as [string, string]),
  ...['sofia'].map((c) => [c, 'BG'] as [string, string]),
  ...['athens'].map((c) => [c, 'GR'] as [string, string]),
  ...['tallinn'].map((c) => [c, 'EE'] as [string, string]),
  ...['riga'].map((c) => [c, 'LV'] as [string, string]),
  ...['vilnius'].map((c) => [c, 'LT'] as [string, string]),
  ...['istanbul', 'ankara'].map((c) => [c, 'TR'] as [string, string]),
  // North America
  ...['new york', 'brooklyn', 'los angeles', 'chicago', 'houston', 'phoenix',
      'philadelphia', 'san antonio', 'san diego', 'dallas', 'austin',
      'san jose', 'san francisco', 'seattle', 'denver', 'boston', 'atlanta',
      'miami', 'detroit', 'minneapolis', 'nashville', 'charlotte', 'raleigh',
      'pittsburgh', 'baltimore', 'cleveland', 'indianapolis', 'milwaukee',
      'sacramento', 'las vegas', 'orlando', 'tampa', 'salt lake city',
      'kansas city', 'cincinnati', 'oakland', 'palo alto', 'mountain view',
      'sunnyvale', 'santa clara', 'redmond', 'bellevue',
     ].map((c) => [c, 'US'] as [string, string]),
  ...['toronto', 'vancouver', 'montreal', 'calgary', 'ottawa', 'edmonton',
      'winnipeg', 'waterloo', 'halifax',
     ].map((c) => [c, 'CA'] as [string, string]),
  ...['mexico city', 'guadalajara', 'monterrey'].map((c) => [c, 'MX'] as [string, string]),
  // APAC / other
  ...['bangalore', 'bengaluru', 'mumbai', 'delhi', 'new delhi', 'hyderabad',
      'chennai', 'pune', 'kolkata', 'ahmedabad', 'noida', 'gurgaon', 'gurugram',
     ].map((c) => [c, 'IN'] as [string, string]),
  ...['singapore'].map((c) => [c, 'SG'] as [string, string]),
  ...['tokyo', 'osaka', 'kyoto'].map((c) => [c, 'JP'] as [string, string]),
  ...['seoul'].map((c) => [c, 'KR'] as [string, string]),
  ...['beijing', 'shanghai', 'shenzhen'].map((c) => [c, 'CN'] as [string, string]),
  ...['hong kong'].map((c) => [c, 'HK'] as [string, string]),
  ...['taipei'].map((c) => [c, 'TW'] as [string, string]),
  ...['bangkok'].map((c) => [c, 'TH'] as [string, string]),
  ...['jakarta'].map((c) => [c, 'ID'] as [string, string]),
  ...['manila'].map((c) => [c, 'PH'] as [string, string]),
  ...['kuala lumpur'].map((c) => [c, 'MY'] as [string, string]),
  ...['ho chi minh city', 'hanoi'].map((c) => [c, 'VN'] as [string, string]),
  ...['sydney', 'melbourne', 'brisbane', 'perth', 'adelaide', 'canberra'].map((c) => [c, 'AU'] as [string, string]),
  ...['auckland', 'wellington'].map((c) => [c, 'NZ'] as [string, string]),
  ...['dubai', 'abu dhabi'].map((c) => [c, 'AE'] as [string, string]),
  ...['doha'].map((c) => [c, 'QA'] as [string, string]),
  ...['riyadh'].map((c) => [c, 'SA'] as [string, string]),
  ...['tel aviv', 'jerusalem', 'haifa'].map((c) => [c, 'IL'] as [string, string]),
  ...['cairo'].map((c) => [c, 'EG'] as [string, string]),
  ...['nairobi'].map((c) => [c, 'KE'] as [string, string]),
  ...['lagos'].map((c) => [c, 'NG'] as [string, string]),
  ...['johannesburg', 'cape town'].map((c) => [c, 'ZA'] as [string, string]),
  ...['sao paulo', 'rio de janeiro'].map((c) => [c, 'BR'] as [string, string]),
  ...['buenos aires'].map((c) => [c, 'AR'] as [string, string]),
  ...['santiago'].map((c) => [c, 'CL'] as [string, string]),
  ...['bogota'].map((c) => [c, 'CO'] as [string, string]),
  ...['lima'].map((c) => [c, 'PE'] as [string, string]),
]

const CITY_COUNTRY_MAP: ReadonlyMap<string, string> = new Map(CITY_COUNTRY)

const REMOTE_RE = /\b(remote|anywhere|work from home|wfh|distributed|home office|homeoffice|telecommute|telework|virtual|fully distributed|ortsunabhangig)\b/

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Classify a single job posting. Pure and deterministic.
 *
 * Never throws: bad/missing input yields a low-quality classification with a
 * rejectReason rather than an exception, because this runs inside ingest loops
 * where one malformed row must not abort the batch.
 */
export function classifyJob(input: ClassifyInput): Classification {
  const rawTitle = typeof input.title === 'string' ? input.title.trim() : ''
  const rawDescription = typeof input.description === 'string' ? input.description : ''
  const rawLocation = typeof input.location === 'string' ? input.location.trim() : ''
  const rawCompany = typeof input.companyName === 'string' ? input.companyName.trim() : ''

  const title = normalizeText(rawTitle)
  const titlePadded = ` ${title} `
  const tokens = title ? title.split(' ') : []
  const meaningful = tokens.filter((t) => !TITLE_STOPWORDS.has(t))

  const jobFunction = detectFunction(titlePadded)
  const seniority = detectSeniority(titlePadded)
  const language = detectLanguage(rawTitle, rawDescription)
  const geo = parseLocation(rawLocation)
  const isRemote = geo.isRemote || REMOTE_RE.test(titlePadded)
  const jobType = detectJobType(titlePadded, rawDescription, seniority)

  const reject = detectReject({
    rawTitle, title, tokens, meaningful, rawCompany, jobFunction,
  })

  const qualityScore = reject
    ? rejectScore(reject)
    : scoreQuality({ rawTitle, title, tokens, jobFunction, seniority, rawDescription, country: geo.country })

  const result: Classification = {
    jobFunction,
    seniority,
    language,
    country: geo.country,
    isRemote,
    jobType,
    qualityScore,
  }
  if (reject) result.rejectReason = reject
  return result
}

/** Convenience predicate over classifyJob's output. */
export function isLowQuality(c: Pick<Classification, 'qualityScore'>): boolean {
  return c.qualityScore < QUALITY_REJECT_THRESHOLD
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/**
 * Title-only, first-match-wins. Deliberately does NOT read the description:
 * every description mentions every function ("work closely with sales and
 * marketing"), so description matching produced non-deterministic-looking
 * garbage. 'other' is an honest answer.
 */
function detectFunction(titlePadded: string): JobFunction {
  for (const [phrases, fn] of FUNCTION_RULES) {
    for (const phrase of phrases) {
      if (titlePadded.includes(` ${phrase} `)) return fn
    }
  }
  return 'other'
}

function detectSeniority(titlePadded: string): Seniority {
  for (const [re, level] of SENIORITY_RULES) {
    if (re.test(titlePadded.trim())) return level
  }
  return 'unknown'
}

function detectLanguage(rawTitle: string, rawDescription: string): string {
  const raw = `${rawTitle}\n${rawDescription.slice(0, 4000)}`
  const folded = fold(raw)
  const normalized = normalizeText(raw)
  const isLongText = normalized.length > 200

  let german = 0
  // Gender suffix used almost exclusively in German-language postings.
  if (/\((m\s*\/\s*w\s*\/\s*[dxi])\)|\(w\s*\/\s*m\s*\/\s*[dxi]\)|\(m\/w\)/i.test(raw)) german += 3
  if (/[\u00e4\u00f6\u00fc\u00df\u00c4\u00d6\u00dc]/.test(raw)) german += 2
  if (/:in\b|:innen\b/.test(raw)) german += 2 // "Zugchef:in" gender-neutral form
  if (GERMAN_WORD_RE.test(normalized)) german += 3
  if (isLongText) {
    const stopHits = (normalized.match(GERMAN_STOPWORD_RE) || []).length
    if (stopHits >= 8) german += 3
    else if (stopHits >= 4) german += 1
  }

  if (german >= 3) return 'de'

  if (isLongText) {
    if (FRENCH_WORD_RE.test(normalized)) return 'fr'
    if (DUTCH_WORD_RE.test(normalized)) return 'nl'
    if (SPANISH_WORD_RE.test(normalized)) return 'es'
  }

  // Latin-script text with no non-English signal: call it English. Text that is
  // mostly non-Latin script is 'unknown' rather than a confidently wrong guess.
  const latin = (folded.match(/[a-z]/g) || []).length
  if (latin === 0) return 'unknown'
  const nonLatin = (raw.match(
    /[\u0400-\u04ff\u0590-\u05ff\u0600-\u06ff\u0900-\u097f\u3040-\u30ff\u4e00-\u9fff\uac00-\ud7af]/g
  ) || []).length
  if (nonLatin > latin) return 'unknown'
  return 'en'
}

export interface GeoResult {
  /** ISO 3166-1 alpha-2, or null when the location is unparseable. */
  country: string | null
  isRemote: boolean
}

/** Parse a free-text location into an ISO alpha-2 country + remote flag. */
export function parseLocation(rawLocation: string): GeoResult {
  const norm = normalizeText(rawLocation || '')
  if (!norm) return { country: null, isRemote: false }
  const padded = ` ${norm} `
  const isRemote = REMOTE_RE.test(padded)

  // 1. Explicit country name/alias anywhere (longest alias first).
  const aliases = COUNTRY_ALIASES.slice().sort((a, b) => b[0].length - a[0].length)
  for (const [alias, code] of aliases) {
    if (padded.includes(` ${alias} `)) return { country: code, isRemote }
  }

  const tokens = norm.split(' ')
  const last = tokens[tokens.length - 1]

  // 2. Trailing token that can ONLY be a US state code ("Austin, TX").
  if (last && UNAMBIGUOUS_US_STATE_CODES.has(last)) return { country: 'US', isRemote }

  // 3. Full US state name anywhere ("Remote - California").
  for (const state of US_STATE_NAMES) {
    if (padded.includes(` ${state} `)) return { country: 'US', isRemote }
  }

  // 4. Trailing token that can only be a Canadian province ("Toronto, ON").
  if (last && CA_PROVINCE_CODES.has(last) && !ISO_COUNTRY_CODES.has(last)) {
    return { country: 'CA', isRemote }
  }

  // 5. Known city (handles "Berlin, Germany" already caught above, plus bare
  //    "Berlin" and "Munich, DE" where DE is ambiguous with Delaware).
  for (let n = 3; n >= 1; n--) {
    for (let i = 0; i + n <= tokens.length; i++) {
      const candidate = tokens.slice(i, i + n).join(' ')
      const country = CITY_COUNTRY_MAP.get(candidate)
      if (country) return { country, isRemote }
    }
  }

  // 6. Trailing token that is an ISO country code but also a US state code
  //    (CA/DE/IN/OR/...). No city disambiguated it, so prefer the US state
  //    reading — "Sacramento, CA" is far more common than "Somewhere, Canada".
  if (last && US_STATE_CODES.has(last)) return { country: 'US', isRemote }
  if (last && ISO_COUNTRY_CODES.has(last)) return { country: last.toUpperCase(), isRemote }

  return { country: null, isRemote }
}

function detectJobType(titlePadded: string, description: string, seniority: Seniority): JobType {
  const head = ` ${normalizeText(description.slice(0, 1200))} `
  const hay = titlePadded + head
  if (seniority === 'intern') return 'internship'
  if (/\b(internship|praktikum|working student|werkstudent)\b/.test(hay)) return 'internship'
  if (/\b(part time|teilzeit|parttime)\b/.test(hay)) return 'part-time'
  if (/\b(contract|contractor|freelance|freelancer|independant|independent contractor|befristet|ftc|fixed term|b2b)\b/.test(hay)) return 'contract'
  if (/\b(temporary|temp|seasonal|interim)\b/.test(hay)) return 'temporary'
  if (/\b(full time|fulltime|vollzeit|festanstellung|unbefristet|permanent)\b/.test(hay)) return 'full-time'
  return 'unknown'
}

interface RejectInput {
  rawTitle: string
  title: string
  tokens: string[]
  meaningful: string[]
  rawCompany: string
  jobFunction: JobFunction
}

/**
 * The garbage detector. Returns a RejectReason for titles the scraper
 * synthesized from URL slugs / nav menus rather than real postings.
 *
 * Order matters: the blocklists run BEFORE the word-count heuristic so that
 * legitimate single-word titles ("Recruiter", "Analyst") survive while city
 * names that happen to end in "-er" ("Hanover") do not.
 */
function detectReject(input: RejectInput): RejectReason | undefined {
  const { rawTitle, title, tokens, meaningful, rawCompany, jobFunction } = input

  if (!rawTitle) return 'empty-title'

  // Non-Latin script (Japanese, Korean, Chinese, Cyrillic ...). normalizeText
  // strips it to nothing, so every heuristic below would misfire — these are
  // real postings ("ソリューションアーキテクト"), not junk. Judge them as fine.
  if (!title) return undefined

  // URL-slug shape: no spaces + hyphen/underscore joined, or literal URL bits.
  if (/https?:\/\/|%20|\.html?\b|^\//i.test(rawTitle)) return 'url-slug-title'
  if (!/\s/.test(rawTitle) && /[-_]/.test(rawTitle) && rawTitle.length > 8 && rawTitle === rawTitle.toLowerCase()) {
    return 'url-slug-title'
  }

  // Exact multi-word nav / boilerplate phrase, or nav link-text shape.
  if (NAV_PHRASE_BLOCKLIST.has(title)) return 'nav-link-title'
  if (NAV_PATTERN_RE.test(title)) return 'nav-link-title'
  if (NAV_PREFIX_RE.test(title)) return 'nav-link-title'
  if (NAV_SENTENCE_RE.test(title)) return 'nav-link-title'

  // Whole title is a known city (possibly multi-word: "New York").
  if (CITY_BLOCKLIST.has(title)) return 'city-name-title'

  // Every meaningful token is a city, ignoring trailing country/region
  // qualifiers ("Berlin Hamburg", "London, UK", "Toronto, ON").
  const cityCandidates = meaningful.filter((t) => !GEO_QUALIFIER_TOKENS.has(t))
  if (cityCandidates.length > 0 && cityCandidates.every((t) => CITY_BLOCKLIST.has(t))) {
    return 'city-name-title'
  }

  // Whole title is a bare department / tech / nav word ("Backend", "DevOps").
  if (DEPARTMENT_BLOCKLIST.has(title)) return 'bare-department-title'
  if (meaningful.length === 1 && DEPARTMENT_BLOCKLIST.has(meaningful[0])) {
    return 'bare-department-title'
  }

  // Every meaningful token is a department word AND at least one is a nav word
  // ("Marketing Jobs", "All Positions", "Karriere Stellen"). The nav-word guard
  // is what keeps real two-noun titles like "Product Design" alive.
  if (
    meaningful.length > 1 &&
    meaningful.every((t) => DEPARTMENT_BLOCKLIST.has(t)) &&
    meaningful.some((t) => NAV_WORDS.has(t))
  ) {
    return 'nav-link-title'
  }

  // Title is just the company name.
  if (rawCompany && title === normalizeText(rawCompany)) return 'company-name-title'

  // Single unfamiliar word with no agent-noun shape.
  if (meaningful.length === 1) {
    const word = meaningful[0]
    if (!ROLE_NOUNS.has(word) && !ROLE_SUFFIX_RE.test(word)) return 'single-word-non-role'
  }

  // NOTE: a short title with no recognizable role noun ("Strategic Deals",
  // "IT Support") is NOT rejected here. Auditing against the live table showed
  // that rule was ~50% false positives on real postings, so it is only a
  // quality-score penalty now (see scoreQuality). Rejection stays blocklist-
  // driven and high-precision.
  void jobFunction

  return undefined
}

function rejectScore(reason: RejectReason): number {
  switch (reason) {
    case 'empty-title':
      return 0
    case 'city-name-title':
    case 'bare-department-title':
    case 'nav-link-title':
    case 'url-slug-title':
    case 'company-name-title':
      return 2
    case 'single-word-non-role':
      return 8
  }
}

interface ScoreInput {
  rawTitle: string
  title: string
  tokens: string[]
  jobFunction: JobFunction
  seniority: Seniority
  rawDescription: string
  country: string | null
}

function scoreQuality(input: ScoreInput): number {
  const { rawTitle, tokens, jobFunction, seniority, rawDescription, country } = input
  let score = 55

  if (jobFunction !== 'other') score += 15
  if (tokens.length >= 2) score += 10
  if (seniority !== 'unknown') score += 5
  if (rawDescription.trim().length >= 200) score += 10
  else if (rawDescription.trim().length >= 40) score += 4
  if (country) score += 5

  // Short title with no recognizable role noun and no taxonomy hit: probably
  // a fragment, but not confidently junk. De-rank rather than reject.
  if (
    tokens.length <= 2 &&
    jobFunction === 'other' &&
    !tokens.some((t) => ROLE_NOUNS.has(t) || ROLE_SUFFIX_RE.test(t))
  ) {
    score -= 25
  }

  if (rawTitle.length > 120) score -= 10
  if (rawTitle.length > 8 && rawTitle === rawTitle.toUpperCase() && /[A-Z]{4,}/.test(rawTitle)) score -= 8
  if (/[\u2026]|\.\.\.$/.test(rawTitle)) score -= 8
  if (tokens.every((t) => /^\d+$/.test(t))) score -= 40

  return Math.max(0, Math.min(100, score))
}
