# RepoAtlas

Explorez les projets publics de GitHub, découvrez leurs créateurs et comparez les ajouts de leurs forks.

## Démarrer

Node.js 22.9 ou supérieur est nécessaire. Aucune dépendance à installer.

```sh
npm start
```

Ouvrez http://127.0.0.1:4328.

## Fonctionnalités

- Recherche automatique de projets : popularité récente, nouveautés, stars et activité.
- Recherche de développeurs par localisation, nom et langage, avec vingt profils par page.
- Comparaison des forks : commits supplémentaires, retard sur l’origine et liens vers le code.
- Cache de dix minutes pour limiter les appels à GitHub.

Les classements par commits et projets étoilés comparent les vingt profils de la page, présélectionnés par abonnés. Ils ne sont pas des classements mondiaux. Les localisations sont déclarées par les utilisateurs de GitHub. La découverte des forks repose sur un échantillon limité de branches.

## Jeton GitHub

Pour augmenter le quota, créez un jeton personnel à permissions fines avec accès aux dépôts publics en lecture, puis lancez :

```sh
npm run github:token
```

Collez le jeton dans la saisie masquée du terminal. La commande le vérifie et l’enregistre dans `.env`, exclu de Git. Rechargez ensuite l’application. Le jeton reste côté serveur local ; les quotas GitHub restent applicables.

## Usage local

Aucun hébergement ni API payante n’est requis. Le serveur écoute uniquement sur `127.0.0.1` et est prévu pour un usage personnel local.

Licence MIT.
