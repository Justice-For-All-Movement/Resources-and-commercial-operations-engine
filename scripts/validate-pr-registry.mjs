import {readFile} from 'node:fs/promises';
import {parsePrRegistry} from '../registry/pr-contract.mjs';
const body = await readFile(new URL('../registry/prs.json', import.meta.url), 'utf8');
// The registry is a historical record: its PR URLs name the repository as it was when those PRs were made.
// The repository has since moved to the Justice-For-All-Movement organization under the same name. CI therefore
// accepts exactly two identities for the checkout: the recorded one, or its successor (same name, new owner).
// Every other registry rule is still enforced against the recorded identity.
const recorded = JSON.parse(body).repository;
const current = process.env.GITHUB_REPOSITORY || recorded;
const successor = 'Justice-For-All-Movement/' + String(recorded).split('/')[1];
if (current !== recorded && current.toLowerCase() !== successor.toLowerCase())
  throw new Error(`Registry belongs to ${recorded} (successor ${successor}); refusing to validate it for ${current}`);
const repository = recorded;
const {document} = parsePrRegistry(body, repository);
const retired = JSON.parse(await readFile(new URL('../registry/roadmap.json', import.meta.url), 'utf8'));
if (retired.repository !== repository || retired.deprecated !== true || retired.redirectTo !== 'registry/prs.json' ||
    Object.hasOwn(retired, 'milestones') || Object.hasOwn(retired, 'units') || Object.hasOwn(retired, 'plannedPrCount'))
  throw new Error('Only registry/prs.json may contain the active PR plan');
console.log(`Valid PR registry: ${repository}${current === recorded ? '' : ` (checked out as ${current})`}, ${document.units.length} approved units; runtime acceptance is separate.`);
