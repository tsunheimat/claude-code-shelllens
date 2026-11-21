import assert from 'node:assert/strict'
import test from 'node:test'
import {factsOf} from '../hooks/facts.ts'

const step = async command => (await factsOf(command, '/work', async () => ({}))).steps[0]

test('docker uses build tags as the image target, not the context or a build argument', async () => {
  for (const command of ['docker build -t api .', 'docker buildx build --tag=api .',
    'docker image build -f Dockerfile --build-arg MODE=prod -tapi .']) {
    const f = await step(command)
    assert.equal(f.target, 'api', command)
    assert.equal(f.category, 'container image build')
  }
  assert.equal((await step('docker run -t api sh -c "-t copied-command"')).target, 'api')
})

test('curl switches do not eat the URL, but headers, userinfo and query values stay local', async () => {
  for (const command of ['curl -s https://api.example.com/health',
    'curl -fsSL -H "X-Test: opaque-value" --url=https://user:opaque-value@api.example.com/health?q=opaque-value',
    'curl --data-urlencode opaque-value --user opaque-value https://api.example.com/health']) {
    const f = await step(command)
    assert.equal(f.target, 'api.example.com/health')
    assert.doesNotMatch(JSON.stringify(f), /opaque-value/)
  }
  assert.equal((await step('curl https://api.example.com/token/opaque-value')).target, 'api.example.com')
})

test('gh keeps the same run and repo regardless of option placement; a read is not a watch', async () => {
  for (const command of ['gh -R acme/web run watch 42', 'gh run watch 42 --repo acme/web',
    'gh run --repo=acme/web watch 42', 'gh -Racme/web run watch 42']) {
    const f = await step(command)
    assert.equal(f.target, '42, repo acme/web'); assert.equal(f.waits, true)
  }
  assert.equal((await step('gh run view 42')).waits, undefined)
  assert.equal((await step('gh pr checks 42')).waits, undefined)
  assert.equal((await step('gh pr checks 42 --watch')).waits, true)
})

test('kubectl distinguishes resource targets, namespace, watch flags and opaque option values', async () => {
  for (const command of ['kubectl -n prod rollout status deploy/api',
    'kubectl rollout status deploy api --namespace=prod', 'kubectl rollout --namespace prod status deploy/api']) {
    const f = await step(command)
    assert.equal(f.target, 'deploy/api, namespace prod'); assert.equal(f.waits, true)
  }
  assert.equal((await step('kubectl rollout status --watch=false deploy/api')).waits, undefined)
  assert.equal((await step('kubectl --token opaque-value get pods')).target, 'pods')
  assert.equal((await step('kubectl get pods')).waits, undefined)
  assert.equal((await step('kubectl get pods -w')).waits, true)
  assert.equal((await step('kubectl logs -f pod/api')).waits, true)
  const wait = await step('kubectl wait --for=condition=Ready pod/api')
  assert.equal(wait.category, 'Kubernetes resource wait')
  assert.equal(wait.condition, 'Ready is true')
  const opaque = await step('kubectl wait --for=jsonpath=opaque-expression pod/api')
  assert.equal(opaque.target, 'pod/api'); assert.doesNotMatch(JSON.stringify(opaque), /opaque-expression/)
})

test('unknown flags and unsafe identifiers never become plausible-looking targets', async () => {
  for (const command of ['docker build --unknown opaque-value -t opaque-value .',
    'gh run watch --unknown opaque-value', 'curl --unknown opaque-value https://opaque-value.example',
    'gh api opaque-value', 'kubectl exec pod -- opaque-value',
    'docker build --tag=ghp_opaque-value .', 'gh -R acme/ghp_opaque-value run view 42',
    'curl https://ghp_opaque-value.example/health']) {
    assert.doesNotMatch(JSON.stringify(await step(command)), /opaque-value/, command)
  }
})
