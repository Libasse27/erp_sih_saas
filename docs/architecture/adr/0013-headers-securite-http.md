# ADR-0013 — Headers de sécurité HTTP (`helmet`), sans CORS ni CSP applicative

- **Statut** : **Accepté** (2026-09-11)
- **Date** : 2026-09-11
- **Décideurs** : responsable technique (mécanisme `helmet` vs headers manuels ; report explicite
  de CORS)
- **Contexte technique** : `apps/api/src/server.ts` (`createApp()`) — Phase 0, étape 12/13,
  **item 8A** des résidus du sweep de sécurité (item 8 scindé : 8A headers HTTP maintenant, CSP
  hors mandat tant qu'`apps/web` n'a pas de contrat réel).

---

## Contexte

État du dépôt **vérifié par lecture du code**, jamais supposé.

**Zéro header de sécurité HTTP aujourd'hui.** `server.ts` ne fait que
`app.disable('x-powered-by')` (ligne 94). Ni `helmet` ni `cors` ne figurent dans
`apps/api/package.json` (dépendances ni devDependencies) — les deux seraient de véritables
nouvelles dépendances, contrairement à `ConsoleStructuredLogger` (ADR-0012) qui avait
délibérément évité d'en ajouter une pour un besoin de quelques lignes.

**Aucun middleware CORS.** Comportement actuel : un navigateur bloque déjà par défaut tout appel
cross-origin faute d'`Access-Control-Allow-Origin` — aucune régression aujourd'hui, mais rien
n'est non plus explicitement configuré.

**`apps/web` est réellement vide.** `apps/web/package.json` :
_« Non démarré : consomme les contrats du SaaS Core (Phase 0), qui n'existent pas encore »_ ;
`apps/web/src` ne contient aucun fichier. **Aucune origine frontend réelle n'existe à
whitelister aujourd'hui** — inventer une liste d'origines ou une CSP maintenant reviendrait à
deviner une politique pour un client qui n'existe pas.

**Authentification par Bearer token** (`modules/identity/presentation/http/BearerToken.ts`),
jamais par cookie — aucun `cookie-parser` dans le dépôt, aucun `credentials: true` à arbitrer :
une politique CORS ici porterait sur la lecture de réponses par un script tiers, pas sur un CSRF
porté par cookie.

**`trust proxy` non configuré** (défaut Express : `false`) — résidu **AC-G**, déjà ouvert et
explicitement non bloquant pour la Phase 0 depuis ADR-0010 Amendement 1 / ADR-0011 §Résidus 5
(« à trancher avant toute mise en production, aucun déploiement de production n'existant
encore »). `helmet` ne consulte jamais `req.secure`/`trust proxy` pour poser l'en-tête HSTS (il
l'envoie inconditionnellement, un navigateur ne l'honore de toute façon que reçu sur une connexion
réellement sécurisée) : **aucune dépendance réelle entre cette ADR et AC-G**, signalé pour
mémoire, non touché ici.

**`NODE_ENV`** a 4 valeurs (`development`/`test`/`staging`/`production`), avec un précédent déjà
en place dans `config/env.ts` (`envSchema.superRefine` durcit la politique Redis uniquement en
`staging`/`production`) — pas réutilisé ici : aucune des décisions ci-dessous ne nécessite de
branchement par environnement (voir §3).

**Headers déjà posés route par route**, aucun chevauchement : `Cache-Control: no-store`
(session/MFA), `Retry-After` (rate limiting).

---

## Décision

### 1. Mécanisme : adopter `helmet` comme nouvelle dépendance

Pas de réécriture manuelle des ~10 headers de durcissement HTTP (`X-Content-Type-Options`,
`X-Frame-Options`, `Referrer-Policy`, `Strict-Transport-Security`, etc.) : `helmet` est
exactement le niveau d'abstraction attendu pour ce sujet — mûr, largement utilisé, maintenu
activement, teste déjà les valeurs par défaut qu'une réécriture maison risquerait d'oublier ou de
mal régler. Contrairement à `ConsoleStructuredLogger` (ADR-0012, quelques lignes, aucune
dépendance externe équivalente n'existant pour un besoin aussi ciblé), il n'y a ici aucune raison
de dériver un mécanisme maison là où la librairie standard du terrain est le bon choix.

### 2. Aucun middleware CORS dans ce mandat

Pas de liste d'origines, pas de valeur par défaut (ni `*`, ni un placeholder `localhost`). Le
comportement actuel (refus cross-origin implicite par les navigateurs) est déjà correct et ne
régresse rien. La politique CORS explicite (probable variable d'environnement
`CORS_ALLOWED_ORIGINS` ou équivalent) devient une décision dédiée, tranchée quand `apps/web` aura
une origine réelle à whitelister — **même raisonnement que pour la CSP** (§3), pas une simple
coïncidence de calendrier.

### 3. `helmet()` avec `contentSecurityPolicy: false` explicite, reste par défaut

```ts
app.use(helmet({ contentSecurityPolicy: false }));
```

**CSP explicitement désactivée**, pas simplement « pas encore configurée » : `helmet()` active
par défaut une CSP restrictive (`default-src 'self'`, etc.) conçue pour une application qui sert
des pages HTML. Ce dépôt ne sert **que du JSON** (aucune vue, aucun rendu HTML) — activer la CSP
par défaut de `helmet` reviendrait à figer silencieusement une politique jamais décidée, exactement
ce que cette ADR s'interdit explicitement pour la CSP (voir Contexte, `apps/web` vide). La
désactiver **explicitement** (plutôt que de laisser une valeur par défaut inertement présente)
documente l'absence de décision, au lieu de la masquer sous une valeur qui a l'air d'être un choix.

**Le reste des valeurs par défaut de `helmet` est conservé sans modification** :
`Strict-Transport-Security` (HSTS, `max-age` 365 jours + `includeSubDomains` — vérifié contre
`helmet@8.3.0`, `DEFAULT_MAX_AGE = 365 * 24 * 60 * 60`, jamais 180 jours comme dans une version
antérieure de ce document),
`X-Content-Type-Options: nosniff`, `X-Frame-Options: SAMEORIGIN`,
`Referrer-Policy: no-referrer`, `X-DNS-Prefetch-Control: off`, `X-Download-Options: noopen`,
`X-Permitted-Cross-Domain-Policies: none`, `X-XSS-Protection: 0`,
`Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Resource-Policy: same-origin`,
`Origin-Agent-Cluster: ?1`. Aucune de ces valeurs ne dépend d'une origine frontend connue ou
d'un choix de déploiement encore ouvert (contrairement à la CSP et au CORS) : ce sont des
réglages de durcissement génériques, sûrs par construction pour n'importe quel client. En
particulier `Cross-Origin-Resource-Policy: same-origin` ne bloque pas un futur appel `fetch`
cross-origin en mode `cors` (il restreint les chargements `no-cors`, hors sujet pour une API
JSON consommée par `fetch`/XHR) — pas de conflit anticipé avec une future décision CORS.

### 4. Montage : premier middleware de l'application, avant toute route

```ts
const app = express();
app.disable('x-powered-by');
app.use(helmet({ contentSecurityPolicy: false }));
```

Avant même le webhook de paiement (qui reste monté en premier parmi les _routes_) : les headers
de réponse doivent s'appliquer à **toute** réponse du serveur, y compris une éventuelle erreur
précoce. `app.disable('x-powered-by')` reste conservé tel quel — **et reste la SEULE protection
réelle contre `X-Powered-By`**, contrairement à une lecture rapide de la source `helmet` qui
pourrait laisser croire à une redondance : l'option `xPoweredBy` de `helmet` fait
`res.removeHeader('X-Powered-By')` au moment de l'exécution du middleware, alors qu'Express pose
cet en-tête plus tard, au moment de `res.send()` — la suppression de `helmet` intervient donc
**trop tôt** pour avoir un effet si `app.disable('x-powered-by')` n'était pas là. Piège explicite
pour un futur lecteur : retirer `app.disable('x-powered-by')` en croyant `helmet` suffisant
réintroduirait silencieusement l'en-tête.

### 5. Ce que cette ADR ne fait pas

- **N'active aucune CSP** (§3) — résidu explicite, pas un oubli.
- **N'ajoute aucun middleware CORS** (§2) — résidu explicite.
- **Ne touche pas `trust proxy`/AC-G** (Contexte) — aucune dépendance réelle avec le sujet de
  cette ADR, signalé pour mémoire uniquement.
- **Ne modifie aucune route existante, aucun contrôleur, aucun header déjà posé
  route par route** (`Cache-Control`, `Retry-After`) — `helmet` s'applique en amont, sans
  connaissance des routes.
- **N'introduit aucune configuration par variable d'environnement** — un seul appel, une seule
  configuration, valable dans tous les `NODE_ENV` (aucune raison identifiée de différencier dev/
  test/staging/production pour ces headers, contrairement au précédent Redis TLS d'`env.ts`).

---

## Alternatives écartées

| #   | Alternative                                                                                                                   | Motif du rejet                                                                                                                                                                                                                                                                                                                                             |
| --- | ----------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Headers écrits à la main, aucune dépendance                                                                                   | Cohérent avec la discipline « pas de nouvelle dépendance » d'ADR-0012, mais pour ~10 headers aux valeurs éprouvées, une réécriture maison expose à des oublis/erreurs que `helmet` a déjà résolus et testés depuis des années — un besoin de quelques lignes (ADR-0012) n'est pas comparable à la reproduction d'une librairie de durdurcissement complète |
| 2   | Activer la CSP par défaut de `helmet` plutôt que la désactiver explicitement                                                  | Figerait silencieusement une politique (`default-src 'self'`, etc.) jamais décidée pour une API qui ne sert que du JSON — exactement ce que cette ADR s'interdit pour la CSP (Contexte)                                                                                                                                                                    |
| 3   | Middleware CORS avec liste d'origines vide par défaut, pilotée par une variable d'environnement, posé dès maintenant          | Éviterait de rouvrir `server.ts` plus tard, mais configurer une politique pour une origine qui n'existe pas encore risque de se révéler fausse à l'usage — même raisonnement qui a fait écarter la CSP                                                                                                                                                     |
| 4   | Configurer HSTS conditionnellement par `NODE_ENV` (actif seulement en `staging`/`production`, précédent Redis TLS d'`env.ts`) | `helmet` n'inspecte jamais le protocole réel de la requête pour poser HSTS ; l'en-tête envoyé sur une connexion HTTP simple est sans effet côté navigateur (spécification HSTS : honoré seulement si reçu sur une connexion déjà sécurisée) — un branchement par environnement n'apporterait aucune garantie supplémentaire, seulement de la complexité    |

---

## Conséquences

**Acquis**

- Toute réponse HTTP porte désormais les headers de durcissement standard (`X-Content-Type-
Options`, `X-Frame-Options`, `Referrer-Policy`, HSTS, etc.) — sans exception de route, `helmet`
  étant monté avant toute route.
- Item 8A du sweep de sécurité de l'étape 12/13 fermé.
- Aucune régression sur les routes existantes : `helmet` ne touche à aucun corps de réponse, ni
  aux headers déjà posés par les contrôleurs.

**Dette assumée / résidus**

1. **CSP toujours désactivée** — décision dédiée à prendre quand `apps/web` aura un contrat
   frontend réel (origines, ressources, scripts/styles inline éventuels). Résidu 1 de
   [[project_step12_isolation_security_sweep]] (item 8B).
2. **Aucun CORS** — même statut, même dépendance à une origine frontend réelle. Résidu 2.
3. **AC-G (`trust proxy`) reste ouvert**, sans lien de dépendance avec cette ADR (Contexte) —
   continue d'être suivi séparément (ADR-0010/0011).
4. **Divergence documentaire préexistante, non corrigée ici** : `02-roadmap-migration.md`
   (section « Livré » de la Phase 0) mentionne `apps/web : LoginPage, RegisterPage, onboarding`
   comme déjà livré, alors que `apps/web/package.json` et `apps/web/src` montrent un frontend non
   démarré. Signalé pour une correction documentaire séparée, hors périmètre de cette ADR.

---

## Tests attendus

Nouveau fichier `apps/api/test/server/securityHeaders.test.ts`, style repris de
`test/identity/integration/registrationHttp.test.ts` : contre le **vrai** `createApp(root)`
(`buildCompositionRoot()` + `startTestServer`, jamais une app Express minimale ad hoc — la
propriété testée ici est le câblage réel de `server.ts`, pas le comportement de `helmet` isolé) :

- Une requête sur `/health` porte `X-Content-Type-Options: nosniff`,
  `X-Frame-Options: SAMEORIGIN`, `Strict-Transport-Security` (présent, `max-age` strictement
  positif — jamais `max-age=0`, qui neutraliserait HSTS), `Referrer-Policy: no-referrer`.
- **Aucun header `Content-Security-Policy`** n'est présent sur la réponse — preuve directe de la
  désactivation explicite (§3), pas d'une simple absence de configuration.
- **Aucun header `Access-Control-Allow-Origin`** n'est présent, même avec un header `Origin`
  envoyé par le client — preuve directe de l'absence de CORS (§2).
- `X-Powered-By` reste absent (non-régression du comportement déjà acquis via
  `app.disable('x-powered-by')`).
- Non-régression de la coexistence avec les headers déjà posés route par route (`Cache-Control:
no-store` sur session/MFA, `Retry-After` sur un rejet de rate limiting) : déjà couverte
  indirectement par les suites existantes (`mfaEnrollmentHttp.test.ts`,
  `auditEntriesRateLimiting.test.ts`), qui continuent de passer avec `helmet` monté en amont —
  vérifié à l'implémentation, aucune assertion dédiée supplémentaire ajoutée dans ce fichier
  (éviterait une redondance avec des suites qui prouvent déjà la propriété).
