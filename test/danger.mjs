// danger.mjs test — the security property (irreversible commands can never be
// session-whitelisted) rests entirely on isDangerousCommand classifying commands
// correctly, so exercise it against a broad table of real commands. Every SAFE
// entry is an everyday command that must NOT be flagged (a false positive there
// re-pages the user needlessly); every DANGEROUS entry must be flagged.
//
//   node test/danger.mjs

import assert from 'node:assert'
import { isDangerousCommand } from '../scripts/lib/danger.mjs'

// Commands that MUST be flagged (can never ride a blanket "allow for session").
const DANGEROUS = [
  // rm
  'rm -rf /tmp/build',
  'rm -fr node_modules',
  'rm -r -f dist',
  'rm -f -r dist',
  'rm --recursive --force ./cache',
  'sudo rm -rf --no-preserve-root /',
  'RM -RF /etc',                                       // case-insensitive
  // git force / ref deletion / history destruction
  'git push --force origin main',
  'git push -f',
  'git push --force-with-lease',
  'git push origin --delete stale-branch',
  'git push origin :refs/heads/stale',                 // colon "delete" refspec
  'git reset --hard HEAD~3',
  'git clean -fdx',
  'cd /srv && git reset --hard && deploy',             // mid-command
  'git branch -D feature/old',                         // force-delete (capital D)
  'git branch --delete --force old',
  'git stash drop',
  'git stash clear',
  'git reflog expire --expire=now --all',
  'git gc --prune=now',
  'git tag -d v1.0.0',
  'git update-ref -d refs/heads/x',
  // git working-tree discard / rebase
  'git checkout -- src/app.js',
  'git checkout .',
  'git checkout HEAD -- config.json',
  'git restore .',
  'git restore --staged --worktree file.txt',
  'git rebase -i HEAD~3',
  'git rebase main',
  // filesystem
  'find . -name "*.log" -delete',
  'find /tmp -type f -exec rm {} +',
  'shred -u secret.key',
  'rsync -a --delete src/ dst/',
  'chmod -R 777 /var/www',
  'chown -R root:root .',
  'truncate -s 0 app.log',
  'crontab -r',
  ': > important.txt',
  'cat /dev/null > app.log',
  "echo '' > config.json",
  'echo > wipe.txt',
  // disk / device
  'mkfs.ext4 /dev/sda1',
  'dd if=/dev/zero of=/dev/sda bs=1M',
  'echo boom > /dev/sda',
  // SQL / datastore
  "psql -c 'DROP TABLE users;'",
  'mysql -e "TRUNCATE TABLE sessions"',
  'psql -c "DELETE FROM users"',                       // no WHERE
  'dropdb production',
  'mongo --eval "db.dropDatabase()"',
  'redis-cli FLUSHALL',
  'redis-cli -h localhost FLUSHDB',
  'supabase db reset',
  'npx prisma migrate reset --force',
  // IaC / k8s / cloud / containers
  'terraform destroy -auto-approve',
  'terraform apply -destroy',
  'pulumi destroy --yes',
  'vagrant destroy -f',
  'kubectl delete namespace prod',
  'kubectl delete deployment api --all',
  'helm uninstall my-release',
  'aws s3 rb s3://bucket',
  'aws s3 rm s3://bucket --recursive',
  'aws rds delete-db-instance --db-instance-identifier prod',
  'aws ec2 terminate-instances --instance-ids i-123',
  'gcloud sql instances delete prod-db',
  'az group delete --name prod-rg',
  'heroku apps:destroy --app my-app',
  'fly apps destroy my-app',
  'wrangler kv:namespace delete --binding CACHE',
  'docker system prune -af',
  'docker volume rm pgdata',
  // fork bomb
  ':(){ :|:& };:',
]

// Commands that must NOT be flagged (safe to session-whitelist; false positives
// here re-page the user needlessly).
const SAFE = [
  // rm-ish but safe
  'rm file.txt',
  'rm -i old.log',
  'grep -rf pattern src/',                             // -rf flags but no `rm`
  'npm run format',                                    // contains "rm" inside "format"
  // git everyday
  'git status',
  'git push origin main',
  'git push -u origin main',
  'git commit -m "drop support for legacy drivers"',   // "drop" but not DROP TABLE
  'git checkout -b feature/login',
  'git checkout main',
  'git checkout feature/payments',
  'git switch develop',
  'git restore --staged file.txt',                     // unstage only (reversible)
  'git stash',
  'git stash pop',
  'git stash list',
  'git branch -d merged-feature',                      // lowercase -d (merged only)
  'git branch --list',
  'git rebase --abort',                                // restores pre-rebase state
  'git rebase --continue',
  'git tag v2.0.0',
  'git gc',
  // filesystem everyday
  'find . -name "*.tmp"',
  'find src -type f',
  'chmod 644 file.txt',
  'chmod +x deploy.sh',
  'chown me:me file',
  'rsync -av src/ dst/',
  'truncate -s 100M disk.img',
  'crontab -l',
  'crontab -e',
  'echo "hello world" > greeting.txt',                 // writing content to a new file
  'npm run build > build.log',
  'node script.js >> out.log',
  'cat app.log > combined.log',
  // SQL / datastore everyday
  'psql -c "DELETE FROM sessions WHERE expired_at < now()"',
  'psql -c "SELECT * FROM users"',
  'redis-cli GET session:123',
  'redis-cli SET key value',
  'prisma migrate dev',
  // IaC / k8s / cloud / containers everyday
  'terraform plan',
  'terraform apply',
  'pulumi up',
  'kubectl get pods',
  'kubectl apply -f deploy.yaml',
  'helm list',
  'helm install myapp ./chart',
  'aws s3 ls',
  'aws s3 cp file.txt s3://bucket/',
  'aws ec2 describe-instances',
  'gcloud compute instances list',
  'az account show',
  'docker ps -a',
  'docker build -t app .',
  'docker volume ls',
  'docker compose up -d',
  'wrangler deploy',
  'wrangler tail',
]

let pass = 0, fail = 0
const check = (cmd, expected) => {
  const got = isDangerousCommand('Bash', { command: cmd })
  if (got === expected) { pass++ }
  else { fail++; console.error(`  ✗ ${expected ? 'expected DANGEROUS' : 'expected SAFE'}: ${JSON.stringify(cmd)} → got ${got}`) }
}

console.log('\nFleet Commander — isDangerousCommand classification\n')
for (const c of DANGEROUS) check(c, true)
for (const c of SAFE) check(c, false)

// Shape handling: raw string input, and tools with no command are never dangerous.
assert.strictEqual(isDangerousCommand('Bash', 'rm -rf /'), true, 'accepts a raw string command')
assert.strictEqual(isDangerousCommand('Write', { file_path: '/etc/passwd' }), false, 'file tools have no command → not dangerous')
assert.strictEqual(isDangerousCommand('Bash', undefined), false, 'missing input → not dangerous')
assert.strictEqual(isDangerousCommand('Bash', { command: '' }), false, 'empty command → not dangerous')
pass += 4

if (fail) { console.error(`\n✗ ${fail} misclassified, ${pass} correct\n`); process.exit(1) }
console.log(`✅ ${pass} commands classified correctly (${DANGEROUS.length} dangerous, ${SAFE.length} safe, + 4 shape checks)\n`)
