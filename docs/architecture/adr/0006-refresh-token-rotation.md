# ADR-0006 — Sessions avancées : refresh token à rotation, détection de réutilisation, expiration différenciée

- **Statut** : **Proposé** — implémentation livrée et corrigée après revue de sécurité
  indépendante (voir §"Corrections apportées après revue de sécurité indépendante"), valeurs
  numériques de durée en résidu explicite (héritées d'O-06.1/O-06.2, non tranchées par cette ADR)
- **Date** : 2026-08-28
- **Décideurs** : Architecture (proposition) + responsable technique (validation attendue, mêmes
  modalités qu'ADR-0005)
- **Contexte technique** : module `identity`, Phase 0, étape 8/13 (« Sessions/refresh-token
  rotation »)

---

## Contexte

[O-06](../03-open-decisions.md#o-06--durée-de-session-et-expiration-dinactivité) est **clos
structurellement** depuis le 2026-08-23 : le mécanisme (O-06.5 : fenêtre glissante, refresh token
à rotation, détection de réutilisation, révocation de chaîne, compatibilité avec le changement de
contexte d'O-05) est acté sans ambiguïté. Seules les **valeurs numériques** des plafonds absolus
(O-06.1) et des paliers d'inactivité (O-06.2) restent un résidu explicite : *« Aucune valeur par
défaut n'a été inventée. »* Cette ADR ne tranche **pas** ce résidu — elle construit le mécanisme et
la structure de politique par catégorie que le résidu viendra remplir, sans jamais inventer de
chiffre définitif à sa place (voir §3).

État du dépôt à la date de cette ADR (étape 7/13, ADR-0005) : sessions server-side opaques
(`sessionId`), Redis, TTL d'hygiène plate (24h), aucun concept de refresh token, d'access token ou
de chaîne de session. Le fichier `RedisSessionStore.ts` anticipait déjà explicitement ce travail
(commentaire : *« À remplacer par l'expiration différenciée par catégorie lors de l'étape "Sessions
avancées"... cette classe n'a pas besoin d'être réécrite pour cela »*).

---

## Décision

### 1. Catégories de sensibilité : **trois** valeurs, calquées sur ce qu'O-04.1 implémente réellement

O-06.1/O-06.2 exigent une différenciation *« alignée sur les mêmes catégories qu'O-04.1 (pas une
troisième taxonomie de risque) »*. Or `MfaPolicy.ts` (étape 2/13, inchangé) ne matérialise **pas**
quatre catégories distinctes : il produit un **booléen** `requiresMfa`, en fusionnant « admin
tenant » et « finance à fort impact » en une seule condition (`TENANT_ADMIN_RESOURCES` ∪
`HIGH_IMPACT_FINANCE_PERMISSION_CODES`), plus une règle fixe et inconditionnelle pour `PLATFORM`
(`SUPER_ADMIN`).

**Décision** : `SessionSensitivityCategory` réutilise exactement cette forme, sans l'affiner :

```ts
type SessionSensitivityCategory = 'PLATFORM_SUPER_ADMIN' | 'TENANT_MFA_REQUIRED' | 'TENANT_STANDARD';
```

Inventer une distinction `TENANT_ADMIN` vs `FINANCE_HIGH_IMPACT` à ce stade créerait précisément la
« troisième taxonomie » qu'O-06.1 interdit, puisque cette distinction n'existe nulle part ailleurs
dans le code exécutable — elle resterait un raffinement non vérifiable, non testé, et divergent du
comportement MFA réel. La fonction `resolveSessionSensitivityCategory()` est ajoutée à
`MfaPolicy.ts` (additif ; `requiresMfaForPlatformContext`/`requiresMfaForMembership` restent
inchangées, testées, non touchées) et réutilise les **mêmes** ensembles de ressources/permissions —
une seule source de vérité pour ce qui est « sensible ».

Explicitement **hors périmètre** de cette catégorisation (donc hors périmètre du calcul de durée) :
le « poste partagé / accueil » (O-06.4). Ce n'est pas une catégorie de rôle/permission mais une
caractéristique de **poste de travail**, qu'aucun signal existant (session, membership, rôle) ne
permet de détecter côté serveur. L'introduire ici obligerait à inventer un nouveau concept (un
indicateur « appareil partagé » transmis à la connexion) qu'aucune décision n'a demandé. Le
verrouillage manuel (« Verrouiller / Changer d'utilisateur », O-06.4) reste un mécanisme
client/UX ; l'expiration d'inactivité courte qui l'accompagne peut être satisfaite plus tard par une
quatrième valeur de catégorie **additive**, sans réécriture.

### 2. `SessionContext` porte sa catégorie ; le calcul de TTL Redis n'a rien à re-résoudre

`sensitivityCategory` est ajouté aux variantes `PlatformSessionContext`/`TenantSessionContext` de
`SessionStore.ts` (jamais à `MfaPendingSessionContext`, dont la fenêtre courte et non négociable
est indépendante de cette politique). Calculé **une fois**, dans `SessionContextIssuer.buildSession`
— la seule fabrique de `SessionContext` — puis transporté tel quel. `RedisSessionStore` n'a ainsi
jamais besoin d'importer `MfaPolicy` ni de re-résoudre des rôles : il lit `session.sensitivityCategory`
et consulte `SessionDurationTuning`, exactement comme son propre commentaire l'anticipait.

### 3. `SessionDurationTuning.ts` : politique par catégorie, valeurs **placeholders non définitives**

Nouveau fichier `domain/SessionDurationTuning.ts`, même esprit que `MfaTuning.ts` : constantes
nommées, commentées, groupées pour rester triviales à ajuster. **Différence assumée avec
`MfaTuning.ts`** : les valeurs de `MfaTuning.ts` ont été *confirmées* par le responsable technique
(2026-08-26) comme défauts d'implémentation ; celles-ci **ne le sont pas**. O-06.1/O-06.2 déclarent
explicitement qu' *« aucune valeur par défaut n'a été inventée »* — cette ADR ne change pas ce
fait. Les constantes ci-dessous sont des **placeholders d'ordre de grandeur conservateur**,
marquées `À VALIDER MÉTIER — NON DÉFINITIF` dans le code, nécessaires uniquement pour que le
mécanisme soit exécutable et testable ; elles n'engagent aucune décision de Direction médicale et
ne doivent **jamais** être citées comme une politique opposable en production avant arbitrage.
Le résidu O-06.1/O-06.2 reste ouvert dans `03-open-decisions.md`, inchangé par cette ADR.

### 4. Refresh token : secret opaque haute entropie, jamais stocké en clair

Génération : `crypto.randomBytes(32)` (256 bits), encodage `base64url` — même famille d'entropie
que les codes de récupération (ADR-0005 §3), largement au-dessus du seuil où un ralentissement
volontaire du hachage aurait un sens. Stockage : `HMAC-SHA-256(pepper, raw)`, enveloppe
`v1.<pepperId>.<hmac>`, poivre `REFRESH_TOKEN_HASH_PEPPER` (variable d'environnement, jamais en
base) — **réutilisation exacte du raisonnement d'ADR-0005 §3** (secret déterministe haute entropie
→ HMAC poivré plutôt qu'Argon2id, pour permettre une recherche indexée en O(1) sans mesure de temps
variable côté vérification, et sans le déni de service auto-infligé d'un hachage lent sur un point
d'entrée pré-authentifié).

### 5. Modèle de chaîne : une ligne par génération, transition atomique par `UPDATE` conditionnel

Chaque utilisation du refresh token consomme la ligne courante et en crée une nouvelle
(`chainId` partagé, `previousTokenId` chaîné) — jamais de mutation en place de la ligne active.
Rotation atomique : `UPDATE ... WHERE token_hash = ? AND status = 'ACTIVE'` (Prisma
`updateMany` conditionnel), **exactement** le pattern déjà en production pour la consommation d'un
code de récupération (ADR-0005 §3 : *« un seul UPDATE conditionnel indexé, atomique par
construction »*) — `count === 0` à cet instant précis signale une **course concurrente perdue**,
distincte d'une réutilisation détectée à la lecture (voir la nuance détaillée juste au-dessus :
échec propre et non punitif, jamais une révocation de chaîne).

Le plafond absolu (`chainStartedAt`/`absoluteExpiresAt`) est fixé à la **création de la chaîne** et
copié tel quel à chaque rotation — jamais recalculé depuis « maintenant » à la rotation, sinon la
fenêtre glissante contournerait indéfiniment le plafond absolu qu'elle est censée respecter.
L'expiration d'inactivité est, elle, recalculée à chaque rotation (`now + inactivitySeconds`),
plafonnée par `absoluteExpiresAt`.

**Nuance nécessaire entre deux origines distinctes d'un `UPDATE` à zéro ligne affectée**
(corrigée après relecture de cette ADR — la version initiale les traitait à tort de façon
identique) :

1. **Lecture de validation** (`RefreshTokenIssuer.validateForRotation`) : la ligne trouvée n'est
   déjà **plus** `ACTIVE` à l'instant de la LECTURE. Une autre transaction a donc déjà achevé
   (lecture ET écriture) une rotation complète avant que celle-ci ne commence — le jeton présenté
   est prouvé **périmé** au moment où il a été présenté. C'est une réutilisation véritable (rejeu
   d'une génération déjà consommée) : traitement du §6 (révocation de toute la chaîne).
**Limite acceptée, non résolue par cette ADR** : les deux origines ci-dessus dépendent de
l'entrelacement réel des deux requêtes. Si la requête gagnante achève **entièrement** sa rotation
(lecture ET écriture) avant même que la requête perdante ne lise la ligne, la perdante tombe dans
le cas 1 (réutilisation) et la chaîne entière — y compris la session que la gagnante vient
d'obtenir légitimement — est révoquée. C'est la limite documentée du modèle de rotation OWASP
standard : le serveur ne peut pas distinguer, après coup, « deux requêtes légitimes envoyées en
même temps » d'« un rejeu ». La réponse correcte relève du **client**, pas du serveur : sérialiser
ses propres appels de renouvellement (verrou applicatif, un seul onglet responsable du
renouvellement) plutôt que présenter deux fois le même jeton sans coordination. Un mécanisme de
« fenêtre de grâce » (tolérer un jeton juste rotaté pendant quelques secondes) existe dans certaines
implémentations pour absorber ce cas, mais introduirait une valeur numérique supplémentaire non
demandée par O-06.5 — hors périmètre de cette étape, à arbitrer séparément si le besoin est
constaté en usage réel.

2. **Perte de la course sur l'`UPDATE` conditionnel lui-même**
   (`RefreshTokenIssuer.completeRotation`) : la ligne était **encore** `ACTIVE` à la lecture de
   validation, mais une requête **concurrente** (deux onglets déclenchant un renouvellement au
   même instant, par exemple) a gagné la course sur l'écriture atomique entre-temps. Il ne s'agit
   **pas** d'un rejeu — la chaîne reste parfaitement valide, prolongée par la requête gagnante.
   Traiter ce cas comme une réutilisation révoquerait la session **légitimement** obtenue par le
   gagnant : un déni de service auto-infligé sur un usage parfaitement normal (deux onglets, un
   double-clic). Traitement : échec propre et **non punitif** pour le perdant
   (`CONCURRENT_REFRESH_CONFLICT`), aucune révocation de chaîne, aucune entrée d'audit
   `SESSION_*` (une perte de course ordinaire n'est pas un signal de sécurité — même absence
   d'audit que tout autre conflit de verrouillage optimiste du dépôt, ex.
   `MfaEnrollmentConcurrencyConflictError`). La garantie exigée (« deux refresh simultanés avec le
   même token → un seul succès ») est ainsi satisfaite sans effet de bord destructeur sur le
   gagnant.

### 6. Détection de réutilisation : révocation de **toute la chaîne**, jamais seulement la ligne présentée

Toute présentation d'un token dont la ligne trouvée porte le statut `ROTATED` (une génération
**déjà consommée** par une rotation antérieure) déclenche : révocation de **toutes** les lignes de
la chaîne (`chainId`), fermeture de **toutes** les sessions Redis associées à la chaîne (voir la
nuance ci-dessous — pas seulement celle du token présenté), et une entrée d'audit
`SESSION_REFRESH_REUSE_DETECTED` (catégorie `SESSION`, voir §8) — pratique OWASP standard pour la
rotation de refresh token. Un plafond absolu ou une inactivité dépassés révoquent également la
chaîne (raisons distinctes, `SESSION_ABSOLUTE_CEILING_EXCEEDED`/`SESSION_INACTIVITY_TIMEOUT`), mais
ne sont **pas** traités comme une attaque : c'est une fin de vie normale, pas une preuve de vol.

**Distinction nécessaire, corrigée après relecture** : un statut `REVOKED` (par opposition à
`ROTATED`) signifie que la chaîne a **déjà** été fermée — déconnexion explicite, changement de
contexte tenant (O-05.1), révocation de membership, ré-enrôlement MFA forcé, ou une réutilisation/
expiration déjà traitée lors d'une tentative précédente. Requalifier **chaque** présentation
ultérieure d'un token issu d'une chaîne déjà fermée en `SESSION_REFRESH_REUSE_DETECTED` inonderait
le journal d'entrées non représentatives d'une attaque (le cas le plus banal : un onglet qui tente
un renouvellement juste après une déconnexion déclenchée depuis un autre onglet), diluant la valeur
de signal de cet événement pourtant qualifié §8 de « le plus critique de cette ADR ». Un troisième
résultat de validation, `CHAIN_ALREADY_REVOKED`, couvre ce cas : refus propre, **sans** nouvelle
révocation (déjà faite, idempotente) ni nouvelle entrée d'audit (l'événement qui a fermé la chaîne
a déjà été, ou n'avait pas à être, audité en son temps). Seul un statut `ROTATED` — la preuve qu'une
génération précise a été consommée par un renouvellement légitime — déclenche `REUSE_DETECTED`.

**Fermeture de session lors d'une révocation de chaîne, précision** : le `sessionId` porté par la
ligne **présentée** ne suffit pas à identifier la session actuellement vivante — si le token
présenté appartient à une génération déjà remplacée par une rotation antérieure, c'est la session
de la génération **suivante** (inconnue de cette ligne) qui est encore réellement active. La
révocation de chaîne retourne donc l'ensemble des `sessionId` **distincts** portés par toutes les
générations de la chaîne, et l'appelant ferme chacun d'eux (suppression Redis idempotente pour les
générations déjà closes).

### 7. Le refresh **ne relance jamais** le contrôle MFA — il prolonge une session déjà pleinement établie

Une chaîne n'est créée que pour une session **complète** (jamais pour `MFA_PENDING` —
`RefreshTokenIssuer.issueChain` retourne `null` dans ce cas). Le renouvellement re-résout les
rôles/permissions/l'accès tenant depuis la base (un membership révoqué ou un tenant suspendu
**pendant** la durée de vie de la chaîne est ainsi détecté — même garantie que
`issueAfterChallenge`, ADR-0005 §4), mais **saute délibérément** la table de décision MFA
(`SessionContextIssuer.issueForRefresh`, nouvelle méthode publique, distincte d'`issueForNewContext`)
et transporte `mfaSatisfiedAt` **tel quel** depuis la ligne consommée — jamais une nouvelle valeur
« maintenant », puisque le second facteur n'a pas été re-prouvé à cet instant.

**Pourquoi ce n'est pas un contournement du plancher MFA (O-04)** : le second facteur a déjà été
prouvé pour ouvrir la session complète dont cette chaîne est issue ; c'est précisément le sens de
« fenêtre glissante » (O-06.5) — prolonger une authentification déjà valide jusqu'au plafond absolu,
sans redemander un facteur déjà fourni. Le **step-up** (O-06.3 : réauthentification renforcée pour
les opérations sensibles, « indépendamment de la fraîcheur apparente de la session ») reste un
mécanisme **orthogonal**, non affecté et non anticipé ici : sa mise en œuvre au niveau
opération/permission suppose une couche de présentation qui n'existe pas encore (ADR-0005, même
résidu déjà tracé : *« Aucune couche HTTP »*). Documenté comme résidu explicite (§ Conséquences).

### 8. Audit : nouvelle catégorie `SESSION`, port dédié — jamais une extension de l'adaptateur MFA

Même raisonnement qu'ADR-0005 §5, alternative 7 explicitement écartée pour l'adaptateur MFA :
*« un futur module qui écrirait d'autres catégories d'audit aurait son propre adaptateur, jamais
celui-ci étendu par un `if` sur l'appelant »*. Un nouveau port `application/ports/SessionAuditTrail.ts`
(union primitive `SessionAuditEventType`, dupliquée côté module `audit` dans
`AuditEventType.ts`, comme `MfaAuditEventType`) et un nouvel adaptateur
`AuditModuleBackedSessionAuditTrail` dans `composition-root.ts`, catégorie fixée à `'SESSION'`.
Écriture toujours **dans la transaction courante**, jamais via l'Outbox — mêmes trois raisons
qu'ADR-0005 §5 (échecs auditables sans agrégat sauvegardé, non-perdable, pas de doublon), avec un
argument renforcé pour `SESSION_REFRESH_REUSE_DETECTED` : c'est l'événement de sécurité le plus
critique de cette ADR, sa perte serait inacceptable.

### 9. Intégration avec le changement de contexte tenant (O-05.1) et les révocations existantes

`ResolveTenantContextHandler` (fermeture de l'ancien contexte, ouverture du nouveau) et
`VerifyMfaChallengeHandler` (émission après second facteur) appellent désormais
`RefreshTokenIssuer.issueChain(session)` juste après `sessionStore.create(session)`, et
`revokeChainBySessionId(previousSessionId)` juste après `sessionStore.delete(previousSessionId)` —
la chaîne suit exactement le cycle de vie déjà établi pour la session elle-même (« fermeture puis
émission, jamais une mutation en place »), sans changer sa structure. `CloseSessionHandler`
(déconnexion), `RevokeMembershipHandler` (révocation de membership) et `ForceMfaReEnrollmentHandler`
(ré-enrôlement administré) sont étendus symétriquement : partout où une session est fermée de force
aujourd'hui, la chaîne de refresh associée l'est désormais aussi — laisser les deux mécanismes
diverger serait une régression de sécurité silencieuse (une chaîne survivante permettrait de
rouvrir une session pourtant explicitement révoquée).

---

## Alternatives écartées

| # | Alternative | Motif du rejet |
|---|---|---|
| 1 | Quatre catégories de sensibilité (incluant « poste partagé ») | Aucun signal serveur n'existe pour détecter un poste partagé ; inventer le concept dépasse le périmètre de cette étape (§1) |
| 2 | Distinguer `TENANT_ADMIN` de `FINANCE_HIGH_IMPACT` | `MfaPolicy.ts` ne matérialise pas cette distinction ; l'introduire ici créerait la « troisième taxonomie » qu'O-06.1 interdit explicitement (§1) |
| 3 | JWT auto-porteur pour le refresh token | Aucune raison de sortir du modèle opaque + store déjà en production pour les sessions ; un JWT ajouterait une surface de vérification de signature sans bénéfice, pour un jeton qui n'est de toute façon jamais lu par le client (§4) |
| 4 | TTL Redis glissante sur chaque requête authentifiée (extension implicite) | Toucherait `ServerContextResolver`, chemin chaud déjà lourdement testé (garde MFA) ; O-06.5 décrit explicitement le renouvellement **via le refresh token**, pas via une prolongation passive sur chaque lecture (§2, §9) |
| 5 | Réappliquer la table de décision MFA à chaque refresh | Contredirait le sens même de « fenêtre glissante » : redemander un facteur déjà prouvé à chaque renouvellement reviendrait à ne jamais avoir de session longue (§7) |
| 6 | Étendre `AuditModuleBackedAuditTrail` avec un paramètre de catégorie | Rejeté explicitement par ADR-0005 §5 alternative 7 pour la même raison ; un nouveau port + un nouvel adaptateur, pas un `if` (§8) |

---

## Conséquences

**Acquis**

- O-06.5 devient opposable : rotation, détection de réutilisation, révocation de chaîne, fenêtre
  glissante bornée par un plafond absolu.
- La structure de différenciation par catégorie (O-06.1/O-06.2) existe et est testée ; seule la
  **valeur** numérique reste à arbitrer — remplacer les constantes de `SessionDurationTuning.ts`
  sera une évolution **purement additive** (aucune migration de schéma, aucune réécriture).
- Le changement de contexte tenant (O-05.1) ferme désormais aussi la chaîne de rotation, pas
  seulement la session — cohérence complète entre les deux mécanismes.
- Toute révocation de session déjà existante (déconnexion, révocation de membership, ré-enrôlement
  MFA forcé) révoque désormais aussi la chaîne de refresh associée.

**Dette assumée**

- **Valeurs numériques non arbitrées** (résidu O-06.1/O-06.2, inchangé par cette ADR) — voir §3.
  Ne jamais présenter `SessionDurationTuning.ts` comme une politique de production tant que ce
  résidu n'est pas fermé par la Direction médicale.
- **Step-up (O-06.3) non appliqué au niveau opération** — le champ `mfaSatisfiedAt` continue
  d'exister et d'être transporté correctement à travers le refresh (jamais fabriqué), mais aucun
  point d'application (« cette opération exige une preuve MFA de moins de N minutes ») n'existe
  encore, faute de couche HTTP/présentation (même résidu qu'ADR-0005).
- **« Poste partagé » (O-06.4) non implémenté** — verrouillage manuel et détection d'appareil
  partagé restent hors périmètre, comme documenté en §1.
- **Aucune couche HTTP** pour l'endpoint de refresh — comme pour toutes les commandes Identity
  depuis l'étape 2/13, ce livrable reste au niveau applicatif (`RefreshSessionHandler`), pas encore
  exposé en route.
- **Aucun chaînage par empreinte** sur les entrées d'audit `SESSION` — même dette assumée et
  documentée qu'ADR-0005 §"Dette assumée" pour `AuditEntry` (protection contre le rôle applicatif
  et l'API, pas contre un superuser PostgreSQL).

---

## Corrections apportées après revue de sécurité indépendante (2026-08-28, avant tout commit)

Une revue adversariale indépendante (agent `security`, isolée de l'implémentation) a été menée
sur l'intégralité du diff avant tout commit, conformément à la procédure de sortie de cette étape.
Six constats confirmés ont été corrigés ; aucun n'a nécessité de revoir la conception d'ensemble.

1. **[Sévérité élevée, bloquant] `revokeChain` lisait les `sessionId` à fermer AVANT d'écrire la
   révocation** (deux allers-retours Postgres séparés). Une rotation légitime concurrente pouvait
   committer entre les deux, insérant une nouvelle génération `ACTIVE` dont le `sessionId` n'était
   alors JAMAIS fermé — une session pleinement authentifiée survivait à la révocation de sa propre
   chaîne jusqu'à expiration de sa TTL Redis. **Corrigé** : `PrismaRefreshTokenRepository.revokeChain`
   utilise désormais une unique instruction `UPDATE ... RETURNING "session_id"` — sous
   REPEATABLE COMMITTED (lire : READ COMMITTED, `PgUnitOfWork`), une instruction bloquée par le
   verrou de ligne d'une transaction concurrente reprend APRÈS le commit de cette dernière et
   re-évalue son `WHERE` contre l'état fraîchement committé, capturant donc aussi la génération que
   la rotation concurrente vient d'insérer. Testé par un scénario de régression dédié
   (`refreshTokenRotation.test.ts`, "revocation de chaine CONCURRENTE a une rotation legitime").
2. **[Moyen] Ordre fail-open entre fermeture Redis et révocation Postgres** dans
   `CloseSessionHandler`/`RevokeMembershipHandler`/`ForceMfaReEnrollmentHandler`/
   `ResolveTenantContextHandler` : la session était supprimée AVANT la revocation de chaîne ; un
   échec de cette dernière laissait la chaîne survivre à une fermeture pourtant déjà actée.
   **Corrigé** : ordre inversé partout (révocation Postgres d'abord, nettoyage Redis ensuite,
   fail-closed). `RefreshSessionHandler` recrée en outre la session Redis AVANT de committer la
   rotation (compensée si `completeRotation` échoue), et **relit** la ligne fraîchement créée après
   commit pour détecter une révocation concurrente entre-temps (déconnexion, revocation de
   membership, ré-enrôlement forcé) avant de renvoyer la session au client.
3. **[Moyen] `issueForRefresh` ne re-vérifiait jamais le plancher MFA** : une chaîne ouverte avant
   une élévation de rôle (nouveau rôle faisant tomber le membership sous le plancher MFA d'O-04.1)
   continuait, à chaque refresh, à délivrer une session complète portant les nouvelles permissions
   sensibles sans jamais avoir prouvé de second facteur. **Corrigé** : `issueForRefresh` refuse
   désormais (`CONTEXT_NO_LONGER_AVAILABLE`) si le MFA est devenu exigé (ou un enrôlement devenu
   actif) depuis l'ouverture de la chaîne alors que `previousMfaSatisfiedAt` est `null` — la garde
   ne se déclenche que si la condition est devenue vraie après coup, §7 reste donc respecté pour
   toute chaîne dont la condition MFA n'a jamais changé.
4. **[Moyen] Absence de session Redis d'origine traitée en fail-open** (`mfaSatisfiedAt` dégradé
   silencieusement à `null` plutôt qu'un refus). **Corrigé** : `RefreshSessionHandler` refuse et
   révoque la chaîne si la session d'origine est absente ou en `MFA_PENDING`.
5. **[Faible]** Écriture Redis après commit pouvant transformer une panne transitoire en faux
   `SESSION_REFRESH_REUSE_DETECTED` — résolu par le même réordonnancement que le point 2.
6. **[Faible]** Le commentaire de `RedisSessionStore.ts` affirmait que `ServerContextResolver`
   refuserait une session dont le plafond est dépassé — faux, il ne discrimine que sur `kind`.
   **Corrigé en documentation** (pas en code) : le commentaire reconnaît désormais explicitement
   que le plafond absolu d'une session déjà émise repose uniquement sur la TTL Redis, sans
   contrôle applicatif redondant — aucun contournement identifié, mais une absence de défense en
   profondeur assumée plutôt que faussement niée. Ajouter cette redondance exigerait d'injecter un
   `Clock` dans `ServerContextResolver`, écarté ici pour ne pas alourdir ce chemin chaud déjà
   lourdement testé (voir alternative 4) ; à reconsidérer séparément si le besoin se confirme.

Un septième constat (faible : `actorRoleCodes`/`reason` systématiquement vides sur les audits
`SESSION`) a été partiellement corrigé — `actorRoleCodes` est renseigné quand la session d'origine
le porte encore ; les chemins où elle n'est plus disponible restent vides, dette mineure assumée.

**Limite documentée, non corrigée (comportement voulu, pas un défaut)** : la revue a également
questionné le résultat du "double-submit concurrent du même jeton" (§5, limite déjà documentée
avant la revue) — confirmé comme un compromis accepté du modèle OWASP standard, pas un défaut.
