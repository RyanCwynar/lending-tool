# Candidate Brief — Backend Engineering Assessment (Morpho)

Source: https://morpho-labs.notion.site/Candidate-Brief-Backend-Engineering-Assessment-326d69939e6d812e866ac70a8d817c64
(captured 2026-11-15)

## The brief
> Build something useful for the Morpho ecosystem.

Spend **up to 5 hours** building a backend service that interacts with Morpho's onchain data. Scope is up to us.

## Deliverables
1. Working codebase in a GitHub repo, **including all workflow artefacts and the AI context used to build it** (keep CLAUDE.md, docs/, plans, etc. committed).
2. `BusinessCase.md` (**1 page max**): what we built, why it's valuable to Morpho, how we'd improve it with more time.
3. High-level **architecture section in the README** (orienting, not exhaustive).
4. **Local run instructions** (if not hosted).

They evaluate **judgement, understanding of the Morpho ecosystem, and backend engineering skill**, not polish.
"A smaller, well-scoped project is better than a sprawling half-working prototype."

## Do
- Use **TypeScript**.
- Use a **real data store** (any DB, but be ready to justify the choice).
- Expose data via **REST or GraphQL**.
- Read **onchain data via RPC** from Morpho markets ([morpho-blue](https://github.com/morpho-org/morpho-blue)) and/or Morpho vaults ([vault-v2](https://github.com/morpho-org/vault-v2)). **Do NOT use the Morpho API.**
- Spend real time on the memo: reasoning and scoping count as much as code.

## Don't
- Build a frontend (curl / GraphQL playground is fine).
- Over-invest in DevOps: a `docker-compose.yml` that boots the service is enough. No Terraform/K8s/CI.
- Write new smart contracts.
- Give in to scope creep: a narrow, well-modeled domain with clean data flow beats three half-baked features.
- Ignore **error cases, data integrity, failure paths**.
- Include code we can't explain (they'll ask about it).

## Submission
- GitHub repo link only (no zips or attachments), sent via the notes section of the Ashby link.
- Add as read-access collaborators: `Bladrak`, `oumar-fall`, `milanmorpho`, `tarikbellamine`, `deehanj`, `julien-devatom`.
