# Controle SCA (analyse de composition logicielle)

Mecanisme decide par [`docs/architecture/adr/0014-politique-sca-dependances.md`](../docs/architecture/adr/0014-politique-sca-dependances.md).
Ce document ne redecide rien : il explique comment le mecanisme fonctionne, pour un lecteur qui
n'a pas le contexte de l'ADR sous les yeux.

## Les deux workflows

| Workflow                                                                        | Declencheur                              | Role                                                                                        | Bloquant ?                     |
| ------------------------------------------------------------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------ |
| [`.github/workflows/sca.yml`](../.github/workflows/sca.yml)                     | push/PR vers `main`                      | Controle a l'entree : `high`/`critical`, arbre complet (dev inclus)                         | Oui                            |
| [`.github/workflows/sca-scheduled.yml`](../.github/workflows/sca-scheduled.yml) | cron hebdomadaire + declenchement manuel | Veille continue : toutes severites, publie/actualise une issue GitHub (`label: sca-veille`) | Non — n'echoue jamais un build |

Seul le premier fait autorite pour un blocage (ADR-0014 §7). Le second est un canal de
detection ; son silence ne vaut pas quitus, sa notification ne bloque rien.

## `sca-exceptions.json` — artefact unique

`security/sca-exceptions.json` est **a la fois** le fichier de derogations et la baseline gelee
(ADR-0014 §6) : il n'existe aucun second fichier de baseline. Chaque entree :

```json
{
  "ghsa": "GHSA-xxxx-xxxx-xxxx",
  "package": "nom-du-paquet",
  "reason": "justification — analyse d'exploitabilite, absence de correctif amont, etc.",
  "expires": "AAAA-MM-JJ",
  "approver": "nom de l'approbateur"
}
```

Un avis `high`/`critical` absent de ce fichier, ou couvert par une entree **expiree**, fait
echouer `sca.yml` (`pnpm run sca:gate`, implemente par
[`scripts/sca/check-exceptions.mjs`](../scripts/sca/check-exceptions.mjs)). Une entree expiree
cesse de couvrir l'avis automatiquement — pas de renouvellement tacite. Le rapport signale aussi
les exceptions expirant sous 30 jours, pour nourrir la revue mensuelle (§13) avant le rouge.

**Portee d'une exception : le GHSA, pas le paquet.** Le champ `package` est informatif ; la
couverture se fait uniquement par identifiant GHSA. Si un meme avis touche plusieurs paquets (ex.
un avis `@vitest/mocker` remonte aussi sous `vitest`), une seule entree les couvre tous. Une
entree ne peut donc pas etre limitee a un seul paquet parmi plusieurs affectes par le meme GHSA —
a savoir avant d'ecrire une justification qui ne vaudrait que pour l'un d'entre eux.

## Fail-closed : que se passe-t-il si le registre npm est injoignable ?

Le gate **refuse de conclure** plutot que de rapporter "0 avis". `pnpm audit --json` peut ecrire
un JSON valide mais vide de sens en cas d'echec reseau (`{"error": {...}}`, code de sortie non
nul) ; `check-exceptions.mjs` valide la forme du rapport avant tout traitement et leve une erreur
explicite si `advisories`/`metadata.vulnerabilities` sont absents. En mode `gate`, cela sort en 1
(build rouge, cause explicite dans les logs). En mode `watch`, cela n'echoue jamais le workflow
mais le rapport publie dans l'issue dit "ECHEC — aucune analyse n'a eu lieu", jamais un faux "0
avis" qui laisserait croire a une veille active. Voir `scripts/sca/check-exceptions.test.mjs`
(`pnpm run sca:test`) pour le test de non-regression de ce comportement.

## Pourquoi la CI peut rougir sans commit sur la PR

Le gate appelle `pnpm audit` a chaque execution : un avis publie entre deux commits peut faire
rougir une PR qui ne touche pas aux dependances. C'est une propriete assumee, pas un bug — l'ADR
note qu'un controle SCA n'a nativement pas la propriete "seuils geles" du gate de couverture
(item 10). Ce que la baseline **gele**, c'est la liste versionnee de ce qui est accepte ; l'etat
du monde exterieur, lui, peut toujours faire basculer un run. La reponse est un commit qui ajoute
une exception datee et justifiee (ou corrige la dependance), jamais une modification du seuil.

**Tension avec le motif ecrit de l'ADR-0014 §5, signalee en revue de securite independante** : le
Motif de D-SCA-5/E2 revendique un pipeline "deterministe" au sens ou aucune PR ne rougirait pour
une cause exterieure — propriete que ce mecanisme, tel que construit, ne tient pas litteralement,
car §6 (artefact unique, pas de second fichier de baseline) rend cette propriete structurellement
inatteignable sans reintroduire un second fichier que §6 interdit. Le mecanisme respecte la
definition operationnelle de E2 ("echoue si un avis nouveau apparait par rapport a la reference,
reste vert sinon") et l'esprit de §6, mais pas la lettre du Motif de §5. Tranche par l'addendum
du 2026-09-14 a l'ADR-0014 (fin de document) : §6 prevaut, ce choix est assume, pas subi.

## Adherence connue : `pnpm.overrides` dans `package.json` est une cle depreciee

Les correctifs `js-yaml`/`qs` (D-SCA-6/I2) sont appliques via `pnpm.overrides` dans le
`package.json` racine. Cette cle **n'est plus lue par pnpm ≥ 10** (avertissement emis a chaque
install des pnpm 9.15.0 sur ce poste) ; pnpm 10+ attend ces reglages dans `pnpm-workspace.yaml`.
Le mecanisme fonctionne aujourd'hui car le depot epingle pnpm 9.15.0 (`packageManager` +
workflows) et que le lockfile porte deja les versions resolues — mais toute montee de pnpm
abandonnerait silencieusement ces overrides. `js-yaml` redeviendrait `high`, capte par le gate ;
`qs` redeviendrait `moderate`, **sous le seuil de blocage**, alors que c'est le seul avis
reellement atteignable en production (audit 2026-09-13 §2.3). Toute future migration
`pnpm.overrides` → `pnpm-workspace.yaml` doit etre un prealable explicite de tout mandat de
montee de version pnpm (actuellement F3, ecartee).

## Rituel

Les divergences plateforme/CI et les exceptions proches de leur expiration sont traitees par la
revue mensuelle instituee par l'ADR-0014 §13 (mandat (e), non encore livre au moment de la
redaction de ce fichier).
