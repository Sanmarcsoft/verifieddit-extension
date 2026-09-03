# Security Policy

Verifieddit is published and maintained by **SanMarcSoft LLC**. It is a fork of
Microsoft's [c2pa-extension-validator](https://github.com/microsoft/c2pa-extension-validator)
(MIT). Security reports for **this** extension should go to SanMarcSoft, **not**
to Microsoft.

## Reporting a Vulnerability

**Please do not report security vulnerabilities through public GitHub issues.**

Instead, email **<security@verifieddit.com>** with:

- Type of issue (e.g. trust-badge spoofing, manifest parsing, XSS, CSP bypass)
- Full path(s) of the source file(s) involved
- The affected tag / branch / commit or a direct URL
- Any configuration required to reproduce
- Step-by-step reproduction instructions
- Proof-of-concept or exploit code, if available
- The impact, and how an attacker might exploit it

You should receive an acknowledgement within 72 hours. If you do not, please
follow up to confirm we received the original report.

Because Verifieddit's purpose is to tell people what content to trust, we treat
any flaw that can produce a **false "trusted" or "durable" verdict** as
high-severity and prioritise it accordingly.

## Scope

In scope: the extension's trust evaluation, C2PA/COSE/JUMBF parsing, the
certificate-chain and trust-list logic, the content-script/overlay injection
surface, and the build/supply-chain pipeline.

Out of scope: vulnerabilities in upstream dependencies (report those upstream,
and tell us so we can pin or patch), and issues that require an already
compromised browser or operating system.

## Preferred Languages

We prefer all communications in English.

## Disclosure

SanMarcSoft follows coordinated vulnerability disclosure. We will agree a
disclosure timeline with you and credit you in the release notes unless you
prefer to remain anonymous.
