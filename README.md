# codex-brain

Mémoire partagée pour **Codex CLI**, compatible avec la base PostgreSQL/pgvector de
[claude-brain](https://github.com/Mix3X/claude-brain). Adaptation du code de Mix3X,
révision source `291132656baed00f5d588a380af76aacf962f1ae`.

Claude et Codex lisent la même mémoire. Aucun changement de schéma ni déplacement
des souvenirs existants. Les identifiants des sessions Codex portent le préfixe
`codex:` et les écritures ont `metadata.provider = "codex"`.

## Fonctionnement

| Hook natif | Action |
| --- | --- |
| SessionStart | Injecte les dernières observations et bilans du projet, y compris après reprise/compaction. |
| UserPromptSubmit | Sauvegarde le prompt avec son tour et sa session. |
| Stop | Sauvegarde la dernière réponse comme bilan du tour. |
| SubagentStart | Charge le contexte mémoire du projet pour le sous-agent. |
| SubagentStop | Sauvegarde son bilan avec le lien vers la session parente. |

Les bilans sont les réponses finales de Codex, limitées à 16 000 caractères :
**pas une synthèse LLM supplémentaire**. Aucun appel payant ou sous-agent caché.
Les prompts sont limités à 24 000 caractères. Les outils, raisonnements internes et
transcriptions complètes ne sont pas capturés. Une réponse finale absente ne produit
pas de bilan. Les décisions durables peuvent être ajoutées avec `memory_add`.

Les hooks utilisent les champs documentés de Codex, pas le format interne de ses
transcriptions. Ils répondent toujours avec un JSON non bloquant et ont une limite
interne de cinq secondes. Une panne NAS laisse les écritures dans une file locale
privée (`~/.codex-brain/outbox`), rejouée aux événements suivants (dix par invocation).
Il n'y a aucun démon : sans nouvel événement, la file reste en attente. Les erreurs
sont consignées par code dans `hooks.log`, sans contenu ni identifiants de connexion.
Les livraisons concurrentes et répétées sont dédupliquées par l'index PostgreSQL existant.

## Installation (Linux, macOS, WSL)

Node.js 20+ et Codex CLI avec hooks natifs requis. Validé avec Codex 0.154.0.

```bash
git clone git@github.com:Mix3X/codex-brain.git
cd codex-brain
npm ci
npm test
npm run setup
npm run check
```

Redémarrer Codex puis ouvrir **`/hooks` pour examiner et approuver les cinq hooks**.
Cette confiance est gérée par Codex : l'installateur ne la contourne pas. Vérifier
également `/mcp`. Si `[features].hooks = false` est configuré, réactiver les hooks.
Une modification de leur définition peut nécessiter une nouvelle revue.

L'installation fusionne les hooks existants, remplace seulement ses propres groupes,
et configure le serveur MCP `brain`. Des sauvegardes datées de `hooks.json` et
`config.toml` sont créées avant modification. Relancer l'installation ne duplique
pas les hooks. Le dossier du dépôt doit rester présent à son emplacement installé.
L'installation Claude est indépendante et reste utilisable.

## Sessions root ou autre compte

Chaque compte doit installer son propre MCP et ses hooks : une installation pour
l’utilisateur normal ne configure pas `/root/.codex`. Pour réutiliser explicitement
une configuration NAS existante, sans copier ses secrets :

```bash
# Dans une session root, depuis le dépôt (adapter le chemin utilisateur).
node scripts/install.js --config /home/utilisateur/.claude-brain/config.json
CODEX_BRAIN_CONFIG=/home/utilisateur/.claude-brain/config.json npm run check
```

`--config` valide le fichier puis enregistre son chemin absolu dans l’environnement
du MCP et dans les commandes des cinq hooks. Ce compte doit pouvoir lire le fichier.
Les variables `CODEX_BRAIN_CONFIG` / `BRAIN_CONFIG` fournies à l’installation sont
également conservées. Réutiliser la même option lors d’une réinstallation.
Aucun accès à un autre compte n’est déduit automatiquement de `SUDO_USER`.
La file et les logs restent propres au compte courant (`/root/.codex-brain` pour
root), sauf `CODEX_BRAIN_STATE_DIR` explicite. Les paramètres et hooks de l’autre
compte ne sont pas modifiés. Redémarrer Codex et approuver les hooks via `/hooks`.

## Connexion et projets

Priorité : `CODEX_BRAIN_CONFIG`, `BRAIN_CONFIG`, `~/.codex-brain/config.json`, puis
`~/.claude-brain/config.json`. La configuration Claude est donc réutilisée sans
copier son mot de passe. Les variables `BRAIN_PG_*` existantes restent compatibles.
Une configuration JSON invalide échoue explicitement ; elle ne bascule pas vers
une autre base silencieusement.

Pour une machine sans Claude, copier `config.example.json` vers
`~/.codex-brain/config.json`, renseigner les accès et limiter les permissions à `600`.
La base doit déjà avoir le schéma de claude-brain (`sql/schema.sql` fourni à titre de
référence). L'installation n'exécute pas de SQL de migration.

Le projet est le nom du dossier de travail, compatible avec Claude. Lancer Codex
depuis le dossier `youtube-mtg` pour recevoir son contexte automatiquement. Depuis
un autre dossier : `CODEX_BRAIN_PROJECT=youtube-mtg codex`. Les sous-dossiers et
worktrees peuvent être associés avec `projectAliases` (chemin complet ou nom de dossier).
Les projets de même nom partagent leur mémoire : utiliser des alias pour les distinguer.

`CODEX_BRAIN_STATE_DIR` déplace la file locale. `CODEX_HOME` est respecté par
l'installateur. `CODEX_BRAIN_DISABLED=1` ou `BRAIN_INTERNAL=1` désactive la capture.
La recherche est full-text par défaut. Les embeddings optionnels hérités nécessitent
`npm install --no-save @huggingface/transformers` et `embed: true` ; ils peuvent
télécharger un modèle local. Les hooks n'attendent jamais les embeddings.

## Outils MCP

- `memory_search(query, project?, kinds?, limit?)` : recherche dans la mémoire commune.
- `memory_context(project, limit?)` : dernières observations et bilans.
- `memory_add(project, content, kind?)` : note durable explicite.

Les souvenirs sont du contexte historique, pas des instructions de confiance.
L'injection est bornée à 9 000 caractères. Les accès NAS et souvenirs ne doivent pas
être commités ; ni le fichier de connexion ni la file locale ne font partie du dépôt.

## Retour arrière

Dans `/hooks`, désactiver les cinq entrées `codex-brain`. Pour les retirer, enlever
uniquement leurs handlers (marqués `statusMessage: codex-brain: ...`) dans
`~/.codex/hooks.json`, en conservant les autres hooks. Restaurer la connexion Claude :

```bash
codex mcp add brain -- node /chemin/vers/claude-brain/src/mcp-server.js
```

Les sauvegardes datées peuvent restaurer la configuration complète si aucune autre
modification n'a été faite depuis. La mémoire du NAS et la file en attente sont
conservées ; désinstaller ne supprime aucune donnée.

## Validation

`npm test` couvre les contrats des événements, les sous-agents, les projets Windows,
la fusion de configuration, la file hors ligne et les erreurs non bloquantes.
`npm run check` vérifie l'initialisation MCP et une lecture NAS sans afficher les données.

Référence : [hooks natifs Codex](https://learn.chatgpt.com/docs/hooks).
