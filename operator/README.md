# osiris-kind-operator

Kubernetes operator that implements Osiris session suspend/resume
(`osiris-spec.md` §3.3/3.4) inside a local `kind` cluster named `osiris-kind`.

## What it does

Two CRDs:

- **`OsirisProject`** — a registered project: its `.dev` container image
  (`spec.devContainer`), source path, and default idle timeout / workspace
  size. `metadata.name` *is* the project's unique name — the Kubernetes API
  server enforces uniqueness for free.
- **`OsirisSession`** — one run of a project. `spec.desiredPhase`
  (`Running`/`Suspended`) is client-owned; `status.phase` reflects what the
  controller actually observes (`Pending`/`Running`/`Suspending`/
  `Suspended`/`Resuming`/`Terminating`).

The `OsirisSession` controller (`internal/controller/osirissession_controller.go`)
owns three child objects per session, created once and never recreated:

- a **PersistentVolumeClaim** (the workspace — this is what "surviving
  suspend" means: it is never deleted by a suspend, only by `rm`),
- a **`coordination.k8s.io/v1` Lease** (the activity heartbeat —
  `osiris-server` patches its `renewTime` on every user interaction; the
  controller reads it to decide whether a session has gone idle), and
- a **Deployment** running the project's devcontainer image, scaled to `1`
  (running) or `0` (suspended) — suspend is a scale-to-zero, never a delete.

Idle timeout resolves session override → project default → the operator's
own `--default-idle-timeout-seconds` flag (default `300`, matching the
spec's 5-minute default). Auto-suspend on idle never flips
`spec.desiredPhase` — only an explicit `osiris session suspend`/`resume`
call does that — so a session that goes idle resumes on activity alone,
while an explicitly suspended one needs an explicit resume.

Deleting an `OsirisSession` (`osiris session rm`) drains the Deployment then
the PVC via a finalizer before the CR itself disappears; the Lease is left
to ordinary owner-reference garbage collection.

## Scaffold provenance

Generated with kubebuilder v4 and hand-authored types/controllers on top:

```sh
kubebuilder init --domain osiris.dev --repo github.com/osiris-ide/osiris/operator --plugins go.kubebuilder.io/v4
kubebuilder create api --group osiris --version v1alpha1 --kind OsirisProject --resource --controller
kubebuilder create api --group osiris --version v1alpha1 --kind OsirisSession --resource --controller
```

Because kubebuilder's group+domain convention concatenates them, the actual
API group is `osiris.osiris.dev` (not the shorter `osiris.dev` you might
expect from the spec prose) — e.g. `apiVersion: osiris.osiris.dev/v1alpha1`.

## Local dev

```sh
bash hack/bootstrap.sh          # idempotent: create osiris-kind, build+load the image, deploy
kubectl apply -f config/samples/osiris_v1alpha1_osirisproject.yaml
kubectl apply -f config/samples/osiris_v1alpha1_osirissession.yaml
kubectl get osirissessions
```

Re-run `bash hack/bootstrap.sh` after any code change to rebuild and
redeploy. `make test` runs the envtest-based reconcile suite (no real kind
cluster needed — see [`internal/controller/osirissession_controller_test.go`](internal/controller/osirissession_controller_test.go)
for the covered scenarios: provisioning, explicit suspend/resume,
idle-timeout auto-suspend, and `rm` cleanup).

Standing this cluster up automatically as part of `osiris` CLI/TUI startup
(spec §3.1) is a separate, out-of-scope concern from this operator itself.

## Getting Started (kubebuilder boilerplate)

### Prerequisites
- go version v1.24.6+
- docker version 17.03+.
- kubectl version v1.11.3+.
- Access to a Kubernetes v1.11.3+ cluster.

### To Deploy on the cluster
**Build and push your image to the location specified by `IMG`:**

```sh
make docker-build docker-push IMG=<some-registry>/operator:tag
```

**NOTE:** This image ought to be published in the personal registry you specified.
And it is required to have access to pull the image from the working environment.
Make sure you have the proper permission to the registry if the above commands don’t work.

**Install the CRDs into the cluster:**

```sh
make install
```

**Deploy the Manager to the cluster with the image specified by `IMG`:**

```sh
make deploy IMG=<some-registry>/operator:tag
```

> **NOTE**: If you encounter RBAC errors, you may need to grant yourself cluster-admin
privileges or be logged in as admin.

**Create instances of your solution**
You can apply the samples (examples) from the config/sample:

```sh
kubectl apply -k config/samples/
```

>**NOTE**: Ensure that the samples has default values to test it out.

### To Uninstall
**Delete the instances (CRs) from the cluster:**

```sh
kubectl delete -k config/samples/
```

**Delete the APIs(CRDs) from the cluster:**

```sh
make uninstall
```

**UnDeploy the controller from the cluster:**

```sh
make undeploy
```

## Project Distribution

Following the options to release and provide this solution to the users.

### By providing a bundle with all YAML files

1. Build the installer for the image built and published in the registry:

```sh
make build-installer IMG=<some-registry>/operator:tag
```

**NOTE:** The makefile target mentioned above generates an 'install.yaml'
file in the dist directory. This file contains all the resources built
with Kustomize, which are necessary to install this project without its
dependencies.

2. Using the installer

Users can just run 'kubectl apply -f <URL for YAML BUNDLE>' to install
the project, i.e.:

```sh
kubectl apply -f https://raw.githubusercontent.com/<org>/operator/<tag or branch>/dist/install.yaml
```

### By providing a Helm Chart

1. Build the chart using the optional helm plugin

```sh
kubebuilder edit --plugins=helm/v2-alpha
```

2. See that a chart was generated under 'dist/chart', and users
can obtain this solution from there.

**NOTE:** If you change the project, you need to update the Helm Chart
using the same command above to sync the latest changes. Furthermore,
if you create webhooks, you need to use the above command with
the '--force' flag and manually ensure that any custom configuration
previously added to 'dist/chart/values.yaml' or 'dist/chart/manager/manager.yaml'
is manually re-applied afterwards.

## Contributing
// TODO(user): Add detailed information on how you would like others to contribute to this project

**NOTE:** Run `make help` for more information on all potential `make` targets

More information can be found via the [Kubebuilder Documentation](https://book.kubebuilder.io/introduction.html)

## License

Copyright 2026.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.

