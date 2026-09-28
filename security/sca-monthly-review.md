# Revue mensuelle SCA — procédure et journal

Institué par ADR-0014 §13 (D-SCA-10/J1). Ce document ne redécide rien : il exécute la décision
déjà prise. Un rituel humain qui **consigne des décisions** — il ne remplace aucun des deux
workflows automatiques (`sca.yml`, gate bloquant ; `sca-scheduled.yml`, veille hebdomadaire non
bloquante), voir `security/README.md` pour leurs rôles respectifs.

## Cadence

Une revue par mois civil, sans jour fixe imposé. Le journal porte la date réelle d'exécution, pas
une date planifiée. Une entrée n'est valable que si elle couvre l'intégralité du périmètre
ci-dessous — une revue partielle n'est pas consignée comme l'entrée du mois.

## Responsable

Le rôle « responsable technique », déjà désigné décideur par l'ADR-0014. Chaque entrée du journal
nomme la personne qui a effectivement mené cette revue précise — jamais un nom par défaut ou
supposé.

## Procédure (à exécuter à chaque revue)

1. Consulter le **dernier résultat du gate CI** (`sca.yml` sur `main`, onglet Actions) — état de
   blocage réel actuel. Ne pas se fier à un run local si un run CI plus récent existe.
2. `pnpm sca:watch` — rapport complet, toutes sévérités, sans échouer le build. **Vérifier que le
   rapport est exploitable avant de poursuivre** : en mode `watch`, un échec (registre npm
   injoignable, fichier d'exceptions invalide, etc.) n'échoue jamais le processus (code de sortie
   0) — le rapport affiche alors `ECHEC — aucune analyse n'a eu lieu` au lieu d'un vrai décompte
   d'avis. Un code de sortie 0 ne suffit donc pas à confirmer une analyse réelle. Si `ECHEC`
   apparaît, la revue reste **incomplète** tant qu'un rapport valide n'a pas été obtenu (relancer,
   corriger la cause) — ne jamais consigner l'étape sur la base d'un rapport `ECHEC` comme si
   l'analyse avait eu lieu.
3. Recouper les alertes Dependabot (github.com/<repo>/security/dependabot) avec le rapport de
   l'étape 2, **par identifiant GHSA** — traiter toute divergence entre les deux canaux (ADR §7) ;
   une divergence n'est jamais classée sans suite silencieusement.
4. Examiner **l'intégralité** des exceptions actives de `security/sca-exceptions.json`, pas
   seulement celles proches de l'expiration — puis traiter en priorité celles expirant sous 30
   jours (champ `expiringSoon` du rapport `sca:watch`) : renouveler (nouvelle date + motif
   réévalué, jamais une simple reconduction tacite) ou laisser expirer sciemment (le blocage
   reprend automatiquement — comportement voulu, pas un incident).
5. Consulter le **dernier rapport** publié dans l'issue GitHub `label: sca-veille`, puis
   l'**historique des modifications** de son corps (GitHub conserve les éditions successives,
   sauf suppression par une personne autorisée) pour retrouver les rapports intermédiaires depuis
   la revue précédente — le workflow ne les archive nulle part ailleurs (`sca-watch-report.md`
   n'est écrit que dans le run, jamais conservé comme artefact). Consulter en complément
   l'historique des **exécutions** de `sca-scheduled.yml` (onglet Actions) sur la même période,
   pour repérer d'éventuels **échecs** de la veille elle-même — les logs n'y donnent pas les avis
   détectés, seulement si le run a échoué.
6. `pnpm sca:test` — **uniquement si le mécanisme SCA lui-même a changé** depuis la dernière revue
   (`scripts/sca/`, `sca.yml`, `sca-scheduled.yml`, format de `sca-exceptions.json`) ; pas une
   étape systématique de chaque revue.
7. Consigner ci-dessous, même si « rien à signaler ».

## Gabarit d'entrée

### AAAA-MM-JJ — revue menée par <nom effectif>

- Résultat du dernier gate CI consulté : ...
- Avis nouveaux (`sca:watch` + Dependabot, recoupés par GHSA) : ...
- Divergences plateforme/CI (§7) : ...
- Exceptions actives examinées : <nombre> ; expirant sous 30 jours : ...
- Décisions prises (renouvellement / expiration assumée / correctif / escalade) : ...
- `sca:test` exécuté ? (uniquement si le mécanisme a changé) : oui/non — raison
- Reporté au mois suivant : ...

## Journal

(entrées les plus récentes en tête)

### 2026-09-28 — revue menée par `Libasse27`

- Résultat du dernier gate CI consulté : `sca.yml` sur `main`, SHA `0b03d00` — succès.
- Avis nouveaux (`sca:watch` + Dependabot, recoupés par GHSA) : aucune divergence. `GHSA-82fw-gwwq-j7x9` ; Dependabot affiche 3 occurrences sur deux manifestes et `sca:watch` 2 lignes par paquet. Les deux décomptes sont cohérents.
- Divergences plateforme/CI (§7) : aucune sur les avis. Le rapport de l'issue `sca-veille` est ancien : le run du 28 septembre a évalué `46b9345`, antérieur aux mises à jour de dépendances. Le run a réussi et son résultat identique à celui du 21 septembre explique l'absence d'édition de l'issue.
- Exceptions actives examinées : 1 ; expirant sous 30 jours : aucune. Exception `GHSA-82fw-gwwq-j7x9`, échéance `2026-12-13`.
- Décisions prises : maintenir l'exception jusqu'à réexamen ; aucune reconduction tacite ni modification aujourd'hui.
- `sca:test` exécuté ? Non — aucun changement du mécanisme SCA depuis la dernière exécution rapportée (19/19).
- Reporté au mois suivant : réexaminer l'exception ; vérifier que la veille planifiée évalue un SHA récent de `main`. Le run du 28 septembre a aussi signalé une échéance de migration de l'image `ubuntu-latest` au 19 octobre 2026.
