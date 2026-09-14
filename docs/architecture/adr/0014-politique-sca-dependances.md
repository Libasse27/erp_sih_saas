# ADR-0014 — Politique d'analyse de composition logicielle (SCA) des dépendances

- **Statut** : **Accepté** (2026-09-13)
- **Date** : 2026-09-13
- **Décideurs** : responsable technique (arbitrage de 9 des 10 décisions `D-SCA-*`) ;
  **direction** pour `D-SCA-9` (visibilité du dépôt), explicitement **non tranchée ici** et
  renvoyée telle quelle (§11).
- **Contexte technique** : monorepo `erp_sih_saas` — Phase 0 gelée, **étape 13/13 « CI/CD et
  contrôles de conformité »**, sous-sujet **SCA**. Items 10 (gate de couverture, commit `1539d32`)
  et 11 (contrat OpenAPI, commit `cad3727`) clos. Adhérences : `.github/workflows/ci.yml`,
  `pnpm-workspace.yaml`, `apps/api/package.json`, `apps/api/vitest.config.ts`.
- **Nature** : ADR de **gouvernance et de décision**. Elle n'introduit aucun code, aucune
  dépendance, aucun seuil, aucun fichier de CI (§15). Les travaux qu'elle ouvre sont énumérés en
  fin de document et resteront des mandats séparés.

---

## Contexte

Cette ADR **arbitre** les dix décisions posées, sans recommandation, par l'audit read-only
[`docs/architecture/reports/2026-09-13-sca-audit.md`](../reports/2026-09-13-sca-audit.md)
(686 lignes, 2026-09-13). Ce rapport est la **source de vérité factuelle** du présent document :
chaque décision ci-dessous renvoie à la section et aux lignes qui portent le raisonnement, plutôt
que de le reproduire.

Les quatre constats du rapport qui commandent l'ensemble des arbitrages :

1. **Absence totale de contrôle SCA** — ni en CI (`ci.yml` l. 7-8 exclut explicitement le SCA), ni
   côté plateforme GitHub (Dependabot `disabled`, graphe de dépendances en 404). Onze écarts `E1` à
   `E11` recensés (rapport §2.1, l. 62-76). Ce n'est pas un contrôle mal réglé : c'est une absence.
2. **Aucun des 11 avis en cours n'est exploitable à distance contre le service déployé**
   (rapport §2.3, l. 96-127). Le seul avis réellement atteignable est `qs` via `express`, sur une
   route authentifiée et limitée en débit ; l'avis étiqueté « critique » (`vitest`, CVSS 9.8) est
   conditionné au serveur Vitest UI, **absent du dépôt**. La sévérité déclarée est ici un mauvais
   prédicteur du risque.
3. **La classification `--prod` de pnpm est démontrée imparfaite sur ce dépôt** : `deepmerge-ts`
   apparaît en production alors qu'il vient de la CLI `prisma`, déclarée en devDependency
   (rapport §2.3, l. 109-113 ; §8 point 2, l. 663-664). Tout seuil adossé à cette classification
   hériterait du défaut.
4. **La montée de `vitest` 2 → 3/4 n'est pas un bump de version.** Elle entraîne
   `@vitest/coverage-v8` (épinglée exactement), change le moteur d'instrumentation de couverture,
   et peut donc déplacer des valeurs mesurées adossées aux **seuils gelés de l'item 10**
   (`1539d32`) — le tout sur une suite de plus de 800 tests dont certains sont déjà sensibles au
   parallélisme et au temps réel (résidus `CI-01`/`CI-02`). Rapport §6.2, encadré l. 532-552.

Le dépôt possède par ailleurs un **précédent de gouvernance directement applicable** : la
philosophie des **seuils gelés** du gate de couverture (rapport §4.1, l. 241-247) — un état de
référence versionné, qui ne change d'état que par une décision explicite et relue. Un contrôle SCA
n'a pas nativement cette propriété : l'état du monde extérieur suffit à le faire basculer au rouge
sans un seul commit. Cette différence de nature est le fil conducteur des décisions 5 à 7 ci-dessous.

---

## Décision

### 1. `D-SCA-1` = **A1** — détecter **et** bloquer dès l'étape 13

Le SCA entre dans l'étape 13 comme **gate exécutoire**, pas comme simple observabilité. La mise
sous gate n'est pas différée en Phase 1.

**Motif** : cohérence avec l'ordre de priorité non négociable « SÉCURITÉ > … > NOUVELLES
FONCTIONNALITÉS » ; un contrôle naît avec sa force exécutoire ou ne l'acquiert jamais — l'option
A2 (détection seule) est structurellement exposée au glissement « différé » → « abandonné », que
le rapport identifie lui-même comme son principal mode d'échec. Rapport §3.2, l. 160-182.

**Conséquence assumée** : `D-SCA-3`, `D-SCA-4`, `D-SCA-5` et `D-SCA-6` devaient être tranchées
dans le même mouvement — c'est l'objet de la présente ADR. Ils le sont.

### 2. `D-SCA-2` = **B3** — plateforme GitHub **et** CI, avec des rôles explicitement distincts

Les deux emplacements sont retenus, avec une répartition écrite et non redondante :

| Mécanisme | Rôle | Ce qu'il ferme |
|---|---|---|
| Plateforme GitHub (Dependabot + graphe de dépendances) | **Veille continue** : un avis publié sur un arbre figé, sans commit | `E2`, `E3`, `E4`, `E5` |
| Contrôle en CI | **Contrôle à l'entrée** : aucune dépendance vulnérable non dérogée n'entre dans `main` | `E1`, `E6` |

**Motif** : chaque mécanisme couvre l'angle mort de l'autre — la CI ne voit rien entre deux
commits, la plateforme ne bloque rien. En phase gelée, où les commits se raréfient, la fenêtre
aveugle de la CI seule est le point le plus structurant de l'axe détection. Rapport §3.3,
l. 224-231 ; §3.1, l. 149-152.

L'inconvénient identifié par le rapport (deux sources d'alerte à réconcilier, l. 229-231) est
traité explicitement en **§7** ci-dessous.

### 3. `D-SCA-3` = **C1** — blocage sur `high` + `critical`, sur l'**arbre complet** (dev inclus)

Aucune distinction production/développement n'est établie dans le seuil.

**Motif** : la frontière prod/dev n'est pas fiable avec l'outillage actuel — la démonstration
`deepmerge-ts` (constat 3 du Contexte) interdit de construire un gate sur une classification
prouvée fausse, qui produirait un faux sentiment de précision. Par ailleurs un toolchain compromis
est un vecteur de chaîne d'approvisionnement à part entière : le déclasser n'est pas neutre.
Règle simple, sans classification fragile à maintenir. Rapport §4.2, l. 251-260 ; §2.3, l. 109-113.

**Conséquence assumée** : ce seuil rougirait `main` dès le premier run (1 critique + 3 élevées,
toutes dev). Il rend donc `D-SCA-4` **indispensable et non optionnel** — c'est la décision
suivante, et c'est pourquoi elle est prise dans la même ADR.

### 4. `D-SCA-4` = **D2** — fichier d'exceptions **versionné**, expiration **obligatoire**, approbateur **nommé**

Le régime de dérogation est un fichier vivant **dans le dépôt**, relu en PR comme du code. Chaque
entrée porte **au minimum** :

- l'**avis concerné** (identifiant GHSA / CVE) ;
- la **justification / le motif** (analyse d'exploitabilité, absence de correctif amont, etc.) ;
- la **date d'expiration obligatoire** ;
- l'**approbateur** nommé.

**Motif** : c'est le seul régime qui laisse une trace lisible depuis le dépôt, reproductible
localement, et dont l'oubli se **réveille** au lieu de s'éterniser. L'option D1 (aucune dérogation)
est ingérable dès qu'un avis n'a pas de correctif amont et pousse mécaniquement à désactiver le
gate — le pire état, car il supprime aussi la trace. L'option D3 (dérogation hors dépôt) est
invisible pour un lecteur du code et sans expiration automatique. Rapport §4.3, l. 298-329.

**Limite reconnue et assumée** : sur un projet à un seul mainteneur, l'approbateur peut être le
demandeur — la séparation des tâches est alors théorique (rapport l. 316-317). Le contrepoids est
la revue instituée en §13.

### 5. `D-SCA-5` = **E2** — baseline **gelée** en CI + **job planifié séparé** pour la veille

La CI compare l'arbre de dépendances à un état de référence versionné : elle échoue si un avis
**nouveau** apparaît par rapport à cette référence, et reste verte sinon. En parallèle, un
workflow **planifié** exécute l'audit complet et **notifie sans bloquer**.

**Motif** : strict alignement avec la philosophie des **seuils gelés** de l'item 10 — la CI reste
**déterministe**, une PR qui ne touche pas aux dépendances ne peut pas rougir pour une cause
extérieure. L'option E1 (gate temps réel) romprait cette propriété et introduirait une dépendance
réseau dans un pipeline déjà porteur des résidus `CI-01`/`CI-02`. L'option E3 (veille seule) est
incompatible avec `D-SCA-1`/A1. Rapport §4.4, l. 336-371 ; §4.1, l. 241-247.

**Risque de dérive reconnu** : la baseline peut être élargie par facilité pour faire passer une PR,
exactement comme un seuil de couverture peut être abaissé — sauf que l'enjeu est ici la sécurité
(rapport l. 357-359). Le contrepoids est la relecture en PR (§4) et la revue mensuelle (§13).

### 6. Précision A — le fichier d'exceptions (`D2`) **constitue** la baseline (`E2`) : un seul artefact

**Cette précision ne figure pas dans le rapport d'audit ; elle est ajoutée par le responsable
technique et fait partie intégrante de la décision.**

`D-SCA-4` et `D-SCA-5` ne produisent **pas deux fichiers**. Le fichier d'exceptions versionné **est**
la baseline gelée à laquelle la CI compare l'arbre. Il n'existe **aucun second fichier de baseline**
à maintenir en parallèle, et il est interdit d'en introduire un dans un futur mandat.

Conséquences directes, qui doivent être respectées par toute implémentation :

- un avis présent dans le fichier unique, non expiré, ne fait pas échouer la CI ;
- un avis absent du fichier unique, de sévérité `high` ou `critical` (§3), fait échouer la CI ;
- **une entrée expirée cesse de couvrir l'avis** : le blocage reprend de lui-même, ce qui est
  précisément la propriété recherchée en §4 ;
- il n'existe donc qu'un seul endroit à relire pour savoir ce qui est accepté, par qui, et
  jusqu'à quand.

Le rapport pointait déjà cette convergence (« la baseline **est** la dérogation », l. 361-362) ;
la présente ADR la transforme en contrainte d'implémentation explicite plutôt qu'en simple
observation.

### 7. Précision B — autorité en cas de divergence entre la plateforme et la CI

**Cette précision ne figure pas dans le rapport d'audit ; elle est ajoutée par le responsable
technique et fait partie intégrante de la décision.**

Le rapport exigeait d'écrire « qui fait autorité », faute de quoi une alerte non reproduite en CI
serait classée sans suite (l. 230-231). L'arbitrage est le suivant :

1. **Le résultat du contrôle CI fait autorité** pour la décision de blocage. La comparaison à la
   baseline / fichier d'exceptions unique (§6) est ce qui décide qu'un build passe ou échoue.
2. **Dependabot et la surveillance planifiée sont des canaux de détection, jamais des autorités
   de blocage.** Une alerte de plateforme n'échoue aucun build et ne peut pas, seule, imposer un
   gate ; une absence d'alerte de plateforme ne vaut pas non plus quitus.
3. **Une divergence entre ce que Dependabot signale et ce que la CI voit n'est jamais classée
   automatiquement sans suite.** Elle constitue un point à vérifier, inscrit et traité lors du
   **rituel de revue mensuelle** institué en §13 (`D-SCA-10`/J1). Le silence n'est pas une
   résolution admissible.

### 8. `D-SCA-6` = **I2** — corriger le sous-ensemble à faible risque, déroger formellement pour le reste

| Avis | Traitement retenu |
|---|---|
| `js-yaml` (via `eslint` → `@eslint/eslintrc`) | **Correction** — montée de version à faible risque |
| `qs` (via `express`) | **Correction** — seul avis réellement atteignable (rapport §2.3, l. 101-108) |
| `vitest`, `vite`, `esbuild`, `@vitest/mocker` | **Dérogation formelle**, datée et argumentée, via le mécanisme du §4/§6 |
| `deepmerge-ts` (via CLI `prisma`) | **Dérogation formelle** — correctif dépendant d'une publication amont hors de notre contrôle |

**Motif** : effort strictement proportionné au risque établi au §2.3 du rapport ; ferme le seul
avis atteignable ; produit une trace écrite de ce qui est accepté et jusqu'à quand — trace qui
n'existe aujourd'hui pour **aucun** des 11 avis. Surtout, cette option **découple la montée
`vitest` de la clôture de l'étape 13**, ce que I1 (tout corriger) interdisait en mettant cette
montée sur le chemin critique. Rapport §6.2, l. 565-577.

I3 (ne rien corriger) et I4 (`qs` seul) sont écartés : ils laisseraient ouvert `js-yaml`, peu
risqué à corriger, sans bonne raison.

**Conséquence explicitement acceptée** (rapport l. 576-577) : la **date d'expiration des
dérogations `vitest`** devient de fait l'échéance du futur mandat de montée de version — elle ne
doit donc être choisie ni au hasard ni très loin.

### 9. `D-SCA-7` = **F1** — traiter `onlyBuiltDependencies` maintenant, dans un mandat séparé et borné

Le sujet est retenu **maintenant** (et non renvoyé en résidu) : il relève incontestablement de la
composition logicielle, l'inventaire des 6 paquets exécutant un hook d'installation est déjà fait
(rapport §5.1, l. 379-398), et le vecteur doit être fermé avant l'augmentation du nombre de
dépendances en Phase 1.

**Il fait néanmoins l'objet d'un mandat d'implémentation distinct**, pour la raison que le rapport
identifie lui-même (§5.2, l. 415-419) : toute erreur d'allowlist **casse l'installation**
(`argon2` sans compilation native fait tomber l'authentification, `@prisma/engines` sans
`postinstall` fait tomber la base), et sa vérification exige un `pnpm install` propre — une
mutation que le mandat de rédaction de la présente ADR s'interdit. Le mélanger au câblage du gate
reviendrait de plus à confondre deux causes possibles d'échec CI.

F3 (montée vers pnpm 10) est écartée : changement d'outillage majeur en phase gelée, et qui ne
supprime **pas** le travail d'allowlist de toute façon.

### 10. `D-SCA-8` = **G3** maintenant, puis l'**esprit de G1** plus tard

**Maintenant** : activation du **graphe de dépendances GitHub** — gratuit, immédiat, sans code,
mis à jour en continu, fermant `E3` et partiellement `E8`. C'est une **mesure intermédiaire
assumée**, et l'ADR l'écrit noir sur blanc conformément à l'implication posée par le rapport
(l. 472-473) : **ce n'est pas un SBOM de build**. Il reflète l'état courant, non l'état d'un build
passé — c'est-à-dire précisément ce dont on aurait besoin pendant un incident.

**Plus tard** : un **SBOM de build archivé et horodaté** sera produit **quand un artefact de
production déployable existera réellement**, ce qui n'est pas le cas aujourd'hui. Produire dès
maintenant un artefact horodaté sans consommateur ni procédure de réponse à incident qui s'en
serve n'aurait qu'une valeur théorique (rapport §5.3, l. 445-464).

Le rapport note que le SBOM **n'apparaît nulle part dans le roadmap** (l. 441-443). La présente ADR
en est, à ce jour, la seule trace : son inscription au roadmap relève d'un mandat documentaire
séparé, non exécuté ici (§15).

### 11. `D-SCA-9` = **H3** — statu quo **explicitement tracé**, décision renvoyée à la direction

La visibilité du dépôt (`"visibility": "public"`, fait établi au rapport §5.4, l. 477-479) **reste
un point ouvert**. La présente ADR **ne le tranche pas** : elle l'acte comme **non tranché** et le
documente comme tel, ce qui est la seule chose qui distingue un statu quo d'un oubli — le rapport
souligne que l'état actuel est précisément indistinguable d'un oubli (l. 516-517).

**Motif** : le point relève de la **direction**, pas de l'ingénierie seule ni de la sécurité
applicative. Il est posé ici parce que l'audit l'a rencontré, pas parce que le mandat SCA doit le
résoudre (rapport l. 482-485). Ni H1 (public assumé) ni H2 (bascule en privé) ne sont écartées :
elles sont **suspendues** à un décideur qui n'est pas celui de cette ADR.

**Ce que cette non-décision implique, et qui est assumé** : tant qu'elle n'est pas prise, le code
complet d'un SaaS de santé multi-tenant — routes, schémas, logique RBAC, paramètres de limitation
de débit, modèles de menace des ADR — reste lisible par quiconque, et un éventuel SBOM public
(§10) le serait également.

### 12. Précision C — `SECURITY.md` est un **résidu conditionnel**, pas un oubli ni une tâche implicite

**Cette précision ne figure pas dans le rapport d'audit ; elle est ajoutée par le responsable
technique et fait partie intégrante de la décision.**

`SECURITY.md` est **absent** du dépôt et le mandat AppSec l'appelle (canal de signalement, délai de
qualification annoncé, périmètre — rapport §8 point 4, l. 668-670). Sa rédaction est
**explicitement suspendue à `D-SCA-9`** : publier une politique de divulgation n'a de sens qu'une
fois statué sur qui peut lire le code.

En conséquence, et pour éviter la dérive la plus probable :

- `SECURITY.md` **ne doit être transformé en tâche implicite dans aucun futur mandat SCA** — il
  n'apparaît pas dans la liste des mandats ouverts en fin de document, et ce n'est pas un oubli ;
- il reste tracé comme **résidu conditionnel** (Conséquences, résidu 3), à débloquer par la
  décision de `D-SCA-9` et par elle seule ;
- la **question contractuelle éventuelle** — exigences de bailleurs (type AICS, VIS) ou de clients
  sur la visibilité du code ou du SBOM (rapport §8 point 5, l. 671-674) — est **hors périmètre de
  l'ingénierie**. Elle est à vérifier par la même instance qui tranchera `D-SCA-9`, et non par un
  mandat d'implémentation technique.

### 13. `D-SCA-10` = **J1** — instituer une revue mensuelle des dépendances dès maintenant, avec trace écrite dans le dépôt

Un rituel de revue **mensuel** est institué immédiatement, avec un responsable nommé et une trace
écrite versionnée dans le dépôt.

**Motif** : un contrôle automatisé **détecte**, seul un rituel **décide**. Sans revue, les alertes
s'accumulent sans traitement et les dérogations expirent dans l'indifférence. C'est le mécanisme
qui rend mutuellement soutenables `D2`, `E2`, `I2` et `J1` (rapport §6.3, l. 605-613). Institué
pendant une phase calme, il a une chance de s'ancrer avant l'accélération de la Phase 1.

Le rituel couvre au minimum : les avis nouveaux signalés par la veille planifiée et par Dependabot,
**les divergences plateforme/CI** (§7), et **les dérogations approchant de leur expiration** (§4).

J2 (différer jusqu'à l'existence d'un contrôle automatisé) est écartée car `D-SCA-1`/A1 rend le
contrôle immédiat ; J3 (rituel déclenché par événement) est écartée seule, car en phase gelée
aucune clôture d'étape ne survient pendant des semaines — exactement la fenêtre aveugle que `E2`
cherche à fermer — et parce qu'une expiration de dérogation est un événement **calendaire** par
nature. J3 reste admissible en **complément**, jamais en remplacement.

**Risque reconnu** : un rituel non tenu est pire qu'aucun rituel — il crée une conformité de façade
(rapport l. 610-611).

### 14. Garde-fous permanents — contraintes applicables à **tous** les futurs mandats d'implémentation SCA

Ces cinq contraintes ne valent pas seulement pour le premier mandat : elles s'appliquent à
**chaque** mandat d'implémentation ouvert par cette ADR, y compris ceux qui viendraient s'y ajouter
plus tard.

1. **Aucune montée de version `vitest` / `@vitest/coverage-v8` dans le cadre d'un mandat SCA.** La
   solidarité de version entre ces deux paquets et les seuils de couverture gelés de l'item 10
   (`1539d32`) exige un **mandat séparé, avec sa propre revalidation complète du gate de
   couverture**. Rapport §6.2, encadré l. 532-552 ; §8 point 1, l. 660-662.
2. **Aucune modification des seuils du gate de couverture livré à l'item 10.** Ni abaissement, ni
   ajustement « pour faire passer », ni modification de périmètre — sous aucun prétexte SCA.
3. **Aucun traitement opportuniste des résidus `CI-01` / `CI-02`** à l'occasion d'un mandat SCA.
   Cette flakiness est documentée et sans rapport avec le SCA ; elle relève de son propre mandat,
   conformément à la discipline déjà appliquée (« ne pas traiter en passant, hors mandat
   explicite »).
4. **Un mandat SCA ne doit jamais servir à masquer ou contourner une CI rouge pour une raison sans
   rapport avec le SCA.** Si la CI est rouge au moment de l'implémentation, la cause est
   **diagnostiquée et traitée pour ce qu'elle est** — jamais absorbée silencieusement dans le même
   commit que le câblage SCA.
5. **La traçabilité `avis → exception → expiration → revue` est conservée de bout en bout** dans
   tout mécanisme construit. C'est la propriété qui rend `D2`, `E2`, `I2` et `J1` mutuellement
   soutenables (rapport §6.3, l. 605-613) : une exception sans avis identifié, sans expiration ou
   sans passage en revue vide la politique de sa substance, quelle que soit la qualité de
   l'outillage.

### 15. Ce que cette ADR ne fait pas

- **Elle n'écrit aucun code, n'ajoute aucune dépendance, ne crée ni ne modifie aucun fichier de
  CI**, aucun seuil, aucun fichier d'exceptions. Elle décide ; elle n'implémente pas.
- **Elle ne tranche pas `D-SCA-9`** (§11) — et donc ne déclenche pas la rédaction de `SECURITY.md`
  (§12).
- **Elle ne modifie pas `03-open-decisions.md`** ni `02-roadmap-migration.md`. La mise à jour du
  registre des décisions ouvertes et l'inscription du SBOM de build au roadmap (§10) relèvent d'un
  mandat documentaire séparé.
- **Elle ne corrige aucun des 11 avis** : elle décide de leur traitement (§8), qui reste à exécuter.
- **Elle ne traite pas** le scan de secrets, le SAST, le scan d'image, l'IaC, le DAST, la signature
  d'artefacts ni le déploiement — sujets successifs de l'étape 13, jamais mêlés au même mandat.
- **Elle ne traite pas `E10`** (actions GitHub référencées par tag mobile plutôt qu'épinglées par
  SHA), écart relevé par le rapport (§5.1, l. 399-403) mais non arbitré par les dix décisions
  `D-SCA-*` — reste ouvert (Conséquences, résidu 5).

---

## Alternatives écartées

| #   | Décision  | Alternative                                                              | Motif du rejet                                                                                                                                                                                                                  |
| --- | --------- | ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | D-SCA-1   | **A2** — détection seule maintenant, blocage différé en Phase 1          | Un contrôle non bloquant est un contrôle que l'on apprend à ignorer ; sans jalon de bascule daté, « différé » devient « abandonné » et l'étape 13 se clôt avec un contrôle de conformité incomplet (rapport l. 172-182)          |
| 2   | D-SCA-1   | **A3** — ambition différenciée : bloquant en prod, informatif en dev     | Repose sur une frontière prod/dev démontrée non fiable (`deepmerge-ts`) ; un gate bâti sur une classification fausse crée un faux sentiment de précision (rapport l. 190-195)                                                    |
| 3   | D-SCA-2   | **B1** — plateforme GitHub seule                                         | Non bloquant par nature, et configuration vivant **hors du dépôt** : non versionnée, non relue, désactivable sans trace dans l'historique Git — `E1` et `E6` resteraient ouverts (rapport l. 206-209)                            |
| 4   | D-SCA-2   | **B2** — CI seule                                                        | Ne détecte rien entre deux commits : en phase gelée, `E5` reste grand ouvert alors que c'est le point le plus structurant de l'axe détection (rapport l. 217-220, 149-152)                                                        |
| 5   | D-SCA-3   | **C2** — bloquer sur le périmètre production seulement                   | S'adosse à `pnpm audit --prod`, dont la classification est **prouvée imparfaite ici** ; le signal non bloquant sur le dev finirait ignoré ; ne protège pas contre un paquet de build malveillant (rapport l. 266-268)             |
| 6   | D-SCA-3   | **C3** — bloquer sur `critical` uniquement                               | Rougirait de toute façon aujourd'hui (avis `vitest` CVSS 9.8 non exploitable), laisserait passer des `high` réels, et serait difficile à défendre devant un auditeur sur un SaaS de santé (rapport l. 275-279)                    |
| 7   | D-SCA-3   | **C4** — seuil par exploitabilité plutôt que par sévérité déclarée       | Colle au §2.3 mais coûteux en temps humain et non soutenable durablement par une équipe réduite ; l'allowlist se périme silencieusement ; risque d'auto-justification sans regard extérieur (rapport l. 287-291)                  |
| 8   | D-SCA-4   | **D1** — aucune dérogation, un avis bloquant se corrige                  | Ingérable quand aucun correctif amont n'existe ; pousse mécaniquement à désactiver le gate en urgence, détruisant le contrôle **et** sa trace (rapport l. 301-305)                                                                |
| 9   | D-SCA-4   | **D3** — dérogation hors dépôt (ticket, `dismiss` Dependabot)            | Invisible depuis le code, sans expiration automatique (`E7` resterait partiellement ouvert), perdue en cas de migration de forge, non reproductible en local — incohérent avec un gate qui vit en CI (rapport l. 325-329)         |
| 10  | D-SCA-5   | **E1** — gate temps réel : `pnpm audit` à chaque push/PR                 | Rompt le déterminisme du pipeline (une PR de documentation peut échouer à cause d'un avis publié la veille) et ajoute une dépendance réseau à un pipeline déjà porteur de `CI-01`/`CI-02` (rapport l. 340-344)                    |
| 11  | D-SCA-5   | **E3** — aucun gate CI, veille planifiée seule                           | Rien n'empêcherait l'entrée d'une dépendance vulnérable dans `main` ; incompatible avec `D-SCA-1`/A1 et ne constitue pas un « contrôle de conformité » au sens de l'étape 13 (rapport l. 368-371)                                 |
| 12  | D-SCA-6   | **I1** — tout corriger avant de poser le gate                            | Mettrait la montée `vitest` sur le **chemin critique de l'étape 13**, avec son risque sur les seuils de couverture gelés ; `deepmerge-ts` dépend en outre d'une publication amont hors de notre contrôle (rapport l. 558-563)     |
| 13  | D-SCA-6   | **I3** — ne rien corriger, documenter les 11 avis en risque résiduel     | Un risque accepté sans traitement devient un risque oublié ; laisserait ouvert `qs`, seul avis atteignable, et `js-yaml`, peu risqué à corriger (rapport l. 584-590)                                                              |
| 14  | D-SCA-6   | **I4** — traiter `qs` seul, différer tout le reste                       | Laisserait `js-yaml` ouvert sans bonne raison ; se combine mal avec le seuil C1 retenu, qui suppose un régime de dérogation explicite pour le reste (rapport l. 595-598)                                                          |
| 15  | D-SCA-7   | **F2** — `onlyBuiltDependencies` en résidu séparé et différé             | Le vecteur (6 paquets exécutant du code à l'installation, sans allowlist) reste ouvert pendant ce temps, et le risque de glissement indéfini est réel sans échéance ; le sujet est à sa place dans le périmètre SCA (l. 426-428)  |
| 16  | D-SCA-7   | **F3** — neutraliser via la montée pnpm 9 → 10                           | Changement d'outillage majeur en phase gelée (format de lockfile, `pnpm/action-setup` épinglé en 9.15.0, postes de développement) — et pnpm 10 exige **de toute façon** de déclarer l'allowlist (rapport l. 433-437)              |
| 17  | D-SCA-8   | **G1 dès maintenant** — SBOM de build produit et archivé à l'étape 13    | Produirait un artefact **sans consommateur** : aucun artefact de production déployable n'existe encore, aucune procédure de réponse à incident ne s'en sert — l'esprit de G1 est retenu, mais différé à cette condition (§10)     |
| 18  | D-SCA-8   | **G2** — reporter en Phase 6 avec simple inscription au roadmap          | Laisserait le projet sans **aucun** inventaire pendant les Phases 1 à 5, alors que le graphe de dépendances offre une couverture partielle à coût nul et immédiat (rapport l. 461-464)                                            |
| 19  | D-SCA-9   | **H1** — visibilité publique assumée + `SECURITY.md`                     | **Non écartée : suspendue.** Hors autorité de cette ADR — décision de direction (§11)                                                                                                                                            |
| 20  | D-SCA-9   | **H2** — bascule du dépôt en privé                                       | **Non écartée : suspendue.** Hors autorité de cette ADR — décision de direction (§11)                                                                                                                                            |
| 21  | D-SCA-10  | **J2** — différer le rituel jusqu'à l'existence d'un contrôle automatisé | Sans objet : `D-SCA-1`/A1 livre le contrôle immédiatement, et `D2`/`E2`/`I2` reposent **explicitement** sur l'existence d'une revue pour ne pas dégénérer (rapport l. 619-623)                                                    |
| 22  | D-SCA-10  | **J3 seule** — rituel déclenché par événement plutôt que calendaire      | En phase gelée, aucune clôture d'étape ne survient pendant des semaines — donc aucune revue ; et une expiration de dérogation est un événement **calendaire** par nature. Admissible en complément, pas en remplacement (l. 630-633) |

> **Lecture des lignes 19 et 20.** Elles ne sont pas des rejets. Elles figurent ici pour que leur
> absence de la section Décision ne soit pas interprétée comme un arbitrage implicite : `H1` et
> `H2` restent l'une et l'autre ouvertes, et c'est `H3` (statu quo tracé) qui est retenu **à titre
> de position d'attente explicite**, pas de réponse au fond.

---

## Conséquences

**Acquis**

- Les dix décisions `D-SCA-1` à `D-SCA-10` sont désormais **arbitrées et tracées** — neuf au fond,
  une (`D-SCA-9`) actée comme non tranchée et explicitement renvoyée, ce qui la rend distinguable
  d'un oubli pour la première fois.
- La politique SCA du projet est **écrite** : ambition (gate exécutoire), emplacement (plateforme
  + CI, rôles distincts), seuil (`high`/`critical`, arbre complet), régime de dérogation (fichier
  versionné, expirant, approuvé), mode de fonctionnement (baseline gelée + veille planifiée),
  traitement de l'existant, durcissement de l'installation, inventaire, rituel de revue.
- **Un seul artefact** porte à la fois la dérogation et la baseline (§6) : un seul endroit à
  relire pour savoir ce qui est accepté, par qui, et jusqu'à quand.
- **L'autorité de blocage est écrite** (§7) : plus de zone grise où une alerte non reproduite en CI
  serait classée sans suite.
- Les **11 avis existants** disposent, pour la première fois, d'un traitement décidé et daté (§8) —
  ils n'étaient jusqu'ici documentés nulle part hors du rapport d'audit.
- La montée `vitest` est **explicitement sortie du chemin critique** de l'étape 13 et protégée par
  un garde-fou permanent (§14.1), ce qui met l'item 10 à l'abri d'une régression opportuniste.
- Les futurs mandats d'implémentation héritent de **cinq contraintes écrites** (§14) plutôt que
  d'une vigilance de circonstance.

**Dette assumée / résidus**

1. **Aucun contrôle SCA n'est encore en place** à la date de cette ADR : elle décide, elle
   n'implémente pas. Les écarts `E1` à `E11` restent ouverts jusqu'à l'exécution des mandats
   énumérés ci-dessous. **Une ADR n'est pas un contrôle.**
2. **Le gate démarrera avec une liste d'exceptions non vide** (`vitest`, `vite`, `esbuild`,
   `@vitest/mocker`, `deepmerge-ts`), ce qui affaiblit son message et peut normaliser la
   dérogation. Contrepoids : expiration obligatoire (§4) et revue mensuelle (§13).
3. **`SECURITY.md` reste absent**, en **résidu conditionnel** suspendu à `D-SCA-9` (§12) — ainsi
   que la vérification des éventuelles exigences contractuelles de bailleurs, hors ingénierie.
4. **Le SBOM de build n'existe pas et n'est inscrit à aucun roadmap.** Le graphe de dépendances
   GitHub est une mesure intermédiaire assumée, **pas un SBOM de build** (§10). Son inscription au
   roadmap relève d'un mandat documentaire séparé.
5. **`E10` (actions GitHub non épinglées par SHA) reste ouvert**, non arbitré par les dix décisions
   `D-SCA-*` (§15). Impact limité aujourd'hui (`contents: read`, secrets d'exemple non productifs),
   croissant dès que le déploiement sera câblé.
6. **`03-open-decisions.md` n'est pas mis à jour par cette ADR** : tant que ce sera le cas, le
   registre des décisions ouvertes ne reflétera pas `D-SCA-9` ni les résidus ci-dessus.
7. **Le risque de dérive de la baseline** (élargie par facilité pour faire passer une PR) et
   **celui du rituel de façade** (§13) sont reconnus, non éliminés : ils reposent sur la discipline
   de relecture, sur un projet à effectif très réduit où l'approbateur peut être le demandeur (§4).
8. **La revue mensuelle est un engagement de charge récurrente** pris pendant une phase calme ; sa
   tenue en Phase 1, sous pression de livraison, n'est pas garantie par cette ADR.

---

## Mandats d'implémentation à venir

Cette ADR ouvre les chantiers suivants. **Chacun reste un mandat borné et séparé**, conduit et revu
indépendamment, selon la discipline de clôture déjà appliquée aux items 10 et 11 : *lecture de
l'état réel → décisions → ADR (si nécessaire) → implémentation → revue de sécurité → gates →
commit → push*. Aucun n'est détaillé ni pré-implémenté ici, et aucun ne doit en absorber un autre.

| Réf. | Mandat | Décisions couvertes | Dépendances / ordre |
|---|---|---|---|
| **(a)** | Câblage du contrôle SCA en CI + création du **fichier d'exceptions/baseline unique** (§6) + workflow planifié de veille | `D-SCA-1`, `D-SCA-2`, `D-SCA-3`, `D-SCA-4`, `D-SCA-5` | **Premier**. Aucune dépendance amont. Fournit le mécanisme dont (b) a besoin pour déroger |
| **(b)** | Correction ciblée `js-yaml` + `qs` et **inscription des dérogations datées** pour `vitest`/`vite`/`esbuild`/`@vitest/mocker`/`deepmerge-ts` | `D-SCA-6` (I2) | **Après (a)** — le fichier d'exceptions doit exister pour recevoir les dérogations |
| **(c)** | `onlyBuiltDependencies` : allowlist des 6 paquets à hook d'installation, **validée par une installation propre** | `D-SCA-7` (F1) | Indépendant de (a) et (b). À isoler strictement : une erreur d'allowlist casse l'installation |
| **(d)** | Activation du **graphe de dépendances GitHub** (et configuration Dependabot associée) | `D-SCA-8` (G3), `D-SCA-2` (volet plateforme) | Indépendant ; peut précéder ou suivre (a). Le rôle distinct plateforme/CI (§2) doit être respecté tel qu'écrit |
| **(e)** | Instauration du **rituel de revue mensuelle** et de son support de trace versionné dans le dépôt | `D-SCA-10` (J1) | **Après (a) et (d)** de préférence — la revue porte sur des alertes, des divergences (§7) et des expirations (§4) qui n'existent qu'une fois (a), (b) et (d) livrés |

**Hors périmètre explicite de ces mandats.** La **montée de version `vitest` / `@vitest/coverage-v8`**
ne figure **pas** dans cette liste et ne doit être intégrée à aucun de ces mandats : garde-fou §14.1.
Elle fera l'objet d'un mandat propre, avec revalidation complète de la suite de tests et du gate de
couverture de l'item 10. Ne figurent pas davantage dans cette liste : la rédaction de `SECURITY.md`
(§12, conditionnelle à `D-SCA-9`), le SBOM de build (§10, conditionnel à l'existence d'un artefact
déployable), le traitement de `E10`, la mise à jour de `03-open-decisions.md` et du roadmap, ainsi
que les résidus `CI-01`/`CI-02` (garde-fou §14.3).

---

## Addendum du 2026-09-14 — précision §5 vs §6, à la suite de la revue de sécurité indépendante du mandat (a)+(b)

Le mécanisme livré par le mandat (a) (`.github/workflows/sca.yml`, `scripts/sca/check-exceptions.mjs`)
appelle `pnpm audit` en direct à chaque exécution du gate CI (push/PR vers `main`). Le Motif du §5
revendiquait pour `D-SCA-5`/E2 une propriété de déterminisme au sens où « une PR qui ne touche pas
aux dépendances ne peut pas rougir pour une cause extérieure ». La revue de sécurité indépendante
du mandat (a)+(b) (finding S-6) a signalé que cette propriété, prise à la lettre, n'est **pas**
tenue par le mécanisme construit : un avis publié entre deux commits peut faire rougir une PR sans
rapport avec les dépendances.

Le responsable technique acte ce qui suit, sans rouvrir aucune des dix décisions `D-SCA-*` :

1. Le §6 (artefact unique — le fichier d'exceptions **est** la baseline gelée, aucun second
   fichier de baseline n'est permis) rend cette propriété de déterminisme littérale
   structurellement inatteignable, sans réintroduire un second artefact que le §6 interdit
   expressément.
2. Le mécanisme respecte la définition **opérationnelle** de E2 telle qu'écrite au §5 (« échoue si
   un avis nouveau apparaît par rapport à la référence, reste vert sinon ») et l'esprit du §6 — un
   seul endroit à relire pour savoir ce qui est accepté.
3. **Le §6 prévaut sur la lettre du Motif du §5.** Le gate est donc, de fait, un contrôle qui
   interroge l'état courant du monde à chaque exécution, comparé à une liste d'exceptions
   versionnée — pas un contrôle « gelé » au sens où l'entend le coverage gate de l'item 10
   (commit `1539d32`). C'est cohérent avec le point 4 du Contexte de la présente ADR (« un
   contrôle SCA n'a pas nativement cette propriété [seuils gelés] ») : le §5 aurait dû
   l'anticiper plus explicitement, cet addendum le corrige.
4. Ce choix est documenté pour l'utilisateur du mécanisme dans `security/README.md`
   (section « Pourquoi la CI peut rougir sans commit sur la PR »), qui doit renvoyer à cet
   addendum plutôt qu'au seul point 4 du Contexte.

---

**Documents liés**

- [`reports/2026-09-13-sca-audit.md`](../reports/2026-09-13-sca-audit.md) — audit read-only,
  source factuelle de toutes les décisions ci-dessus
- [`00-executive-summary.md`](../00-executive-summary.md) — règle de gouvernance post-gel
- [`02-roadmap-migration.md`](../02-roadmap-migration.md) — Phase 0, étape 13, critères de sortie
- [`03-open-decisions.md`](../03-open-decisions.md) — décisions `O-*`, résidus `CI-01`/`CI-02`
  (non modifié par cette ADR, §15)
- `.github/workflows/ci.yml` — périmètre CI actuel, SCA explicitement exclu (l. 7-8)
- `apps/api/vitest.config.ts` — seuils de couverture gelés de l'item 10 (commit `1539d32`)
