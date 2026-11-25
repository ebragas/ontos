# Ontos Quickstart Example

This folder holds the starter Ontology that `ontos init` scaffolds: one `Task` Object Type, one `create-task` Action Type, and a `grants.json` permissions file.

## Run against local Docker Compose

Start PostgreSQL and Ontos from the repository root:

```sh
docker compose up -d
```

Publish the Ontology, install it, apply an Action, and query Objects from this folder:

```sh
export ONTOLOGY_TOKEN=ontos-dev-token
npx ontos publish --url http://127.0.0.1:8080 --skip-sdk-package
npx ontos install 127.0.0.1-8080 --api-name tasks --display-name Tasks --url http://127.0.0.1:8080
npx ontos apply com.example.tasks.create-task \
  --parameters '{"taskId":"task-1","title":"Ship Ontos v1","completed":false}' \
  --url http://127.0.0.1:8080
npx ontos objects com.example.tasks.Task --url http://127.0.0.1:8080
```

## Generate the local TypeScript SDK

Run `ontos generate-osdk` after installing dependencies to generate the typed Ontology SDK into `ontology/osdk-output/`:

```sh
npm install
npx ontos generate-osdk
```
