# Agent file storage (Oracle Object Storage)

Two buckets, two keys:

- **`acp-agent-files`**, the files the agent *delivers* (PDFs, decks…). Its key lives on the box.
- **`acp-agent-uploads`**, the documents users *attach*. Its key lives only in the app (see
  [User uploads](#user-uploads)).

The agent's SDK uploads every file it delivers: `publishPdf`, `publishSlides`, `publishDoc`,
`publishScreenshot`, `publishFile` and the image and voice helpers. `publish()` in
`/opt/gs-sdk/storage.mjs` PUTs the bytes to an S3 bucket and returns a presigned GET link
(valid 7 days).

## Why the box needs it

`publish()` uses, in this order:

1. Bucket keys in the environment (`TIGRIS_ACCESS_KEY_ID` / `TIGRIS_SECRET_ACCESS_KEY`, or the
   `AWS_` names).
2. Otherwise Studio's tool endpoint (`GS_TOOLS_URL` + `GS_TOOLS_TOKEN`, from `.gs-turn.json`).

Our box has neither: its turn files are `{}` (see [render-svc.md](render-svc.md#why-the-box-needs-it)).
So rendering works and the delivery step fails:

```
láminas: 4 · piel nocturno · … · problemas: 0
file:///opt/gs-sdk/storage.mjs:66
  if (!AK || !SK) throw new Error(`storage.publish: …
```

We give the box keys to our own bucket in Oracle Object Storage (Always Free: 20 GB), through
its S3-compatible API.

## Setting it up (OCI console)

The VM is in **`mx-queretaro-1`**. Create everything in that region, in the **root compartment**
(the S3 API's default compartment).

1. **Namespace.** Profile menu → *Tenancy* → *Object storage namespace*. A short random string.
2. **Bucket.** *Storage → Buckets → Create bucket*: name `acp-agent-files`, Standard tier,
   **private** (the default). The links the agent hands out are presigned, so the bucket stays
   private.
3. **A user only for this.** A Customer Secret Key has the full rights of the user it belongs
   to, and it sits in a file on the agent box. Do not make it for your admin user.
   - *Identity → Users → Create user* `acp-agent-storage` (no console password).
   - *Groups → Create group* `acp-agent-storage`, add the user.
   - *Policies → Create policy* in the root compartment:

     ```
     Allow group acp-agent-storage to read buckets in tenancy where target.bucket.name='acp-agent-files'
     Allow group acp-agent-storage to manage objects in tenancy where target.bucket.name='acp-agent-files'
     ```

     On an Identity Domains tenancy, write the group as `'Default'/'acp-agent-storage'`.
4. **Keys.** The new user → *Customer secret keys → Generate secret key*. Copy the secret
   right away: it is shown once. The *Access key* is the id in the list.
5. **Optional cleanup.** Bucket → *Lifecycle policy rules → Create*: delete objects after 30
   days. The links die after 7 days anyway.

## The agent box side

Add these five lines to `/etc/ghosty-lite-runtime/.env`, like `GS_RENDER_URL`:

```
TIGRIS_ACCESS_KEY_ID=<access key>
TIGRIS_SECRET_ACCESS_KEY=<secret key>
STORAGE_ENDPOINT=https://<namespace>.compat.objectstorage.mx-queretaro-1.oraclecloud.com
STORAGE_BUCKET=acp-agent-files
STORAGE_REGION=mx-queretaro-1
```

`STORAGE_REGION` must be the real region: the SDK's default, `auto`, is a Tigris value and
Oracle checks the region in the signature. The names say `TIGRIS_` because that is what the SDK reads;
`storage.mjs`, `image.mjs` and `voice.mjs` all read the same five.

One way to add them without the secret landing in your shell history: put the five lines in a
local file `storage.env` (mode 600), then:

```bash
# boxexec: the helper that wraps POST /sandboxes/$AGENT_BOX_ID/exec
B64=$(base64 < storage.env | tr -d '\n')
boxexec "f=/etc/ghosty-lite-runtime/.env; cp -p \$f \$f.bak-\$(date +%F-%H%M%S); sed -i -E '/^(TIGRIS_|STORAGE_)/d' \$f; echo $B64 | base64 -d >> \$f; grep -cE '^(TIGRIS_|STORAGE_)' \$f"
rm storage.env
```

It prints `5`. Then restart the agent, as in
[render-svc.md](render-svc.md#applying-it-restart-the-agent-do-not-create-a-new-one):

```bash
boxexec "systemctl restart ghosty-lite-runtime; sleep 3; systemctl is-active ghosty-lite-runtime"
```

The file is on the box's root disk: a new box needs the lines again.

## Checking it

**Upload and download through the SDK.** The command loads only the five variables from the
env file and prints the HTTP status of the presigned link. It does not print the keys:

```bash
boxexec "cd \$(ls -d /data/work/s/*/ | tail -1) && eval \"\$(sed -nE 's/^(TIGRIS_|STORAGE_)/export &/p' /etc/ghosty-lite-runtime/.env)\" && node --input-type=module -e '
import { publish } from \"/opt/gs-sdk/storage.mjs\";
const r = await fetch(await publish(Buffer.from(\"ok\"), \"check.txt\"));
console.log(r.status, await r.text());'"
```

Expect `200 ok`. Otherwise (the first 200 characters of Oracle's answer follow the status):

- `storage.publish: …TIGRIS_ACCESS_KEY_ID…`: the variables are missing from the env file.
- `storage.publish → 403 … The secret key required to complete authentication could not be
  found. The region must be specified if this is not the home region…`: right after creating
  the key, it has not reached `mx-queretaro-1` yet. Wait a few minutes and retry (seen on
  2026-10-11: it passed on the next try). If it persists, the access key is wrong or deleted.
- `storage.publish → 403` (other messages): wrong access key or secret, `STORAGE_REGION` is not
  `mx-queretaro-1`, or the policy does not cover the bucket.
- `storage.publish → 404`: wrong bucket name or namespace, or the bucket is in another region.
- The upload works but the download (`r.status`) is not 200: the presigned link is wrong. That is
  the SDK's signing in `storage.mjs`, not the console setup.

**The agent process has them** (after the restart). Prints `5`:

```bash
boxexec "tr '\0' '\n' < /proc/\$(systemctl show -p MainPID --value ghosty-lite-runtime)/environ | grep -cE '^(TIGRIS_|STORAGE_)'"
```

Then ask the agent for a PDF or a short deck in the app.

## What the chat shows

The SDK prints each file as an `eb-file` block (JSON with `url`, `name`, `mime`, `size` and,
for slides, a `thumb`) and tells the agent to paste it verbatim. `app/lib/files.ts` finds those
blocks and the web chat draws each one as a download card (`app/components/FileCard.tsx`): the
cover or a type icon, the name, type and size. Only `https:` links become cards; anything else
stays as text. While the answer streams, a block that is not closed yet is held back. WhatsApp
gets the file's name and link instead (`paraWhatsApp`). Tests: `npm run test:files`.

## User uploads

Documents attached in the web chat go to their own bucket, written by the app (not the box):
`POST /api/conversations/:id/uploads` streams the raw bytes to
`<UPLOAD_PREFIX><conversation>/<id>/<name>` and records where in `.data/uploads.db`. The turn then hands
the agent a presigned GET link (1 hour) and the exact `curl` that downloads it into
`adjuntos/` (`app/.server/uploads.ts`, `app/lib/attachments.ts`). The bucket is the copy that
outlives a recreated box, and what a future RAG index reads from.

**Why a separate bucket and key.** The box's key has `manage objects` on `acp-agent-files`, and
anything the agent runs can read it. User uploads in that bucket would be listable by the agent,
across every conversation. The app's key stays on the VM; the box only ever gets one-hour links
to single files.

**Setting it up**, as in [the OCI console steps](#setting-it-up-oci-console):

1. Bucket `acp-agent-uploads`, Standard, private, in `mx-queretaro-1`.
2. User and group `acp-agent-uploads` (no console password), policy in the root compartment:

   ```
   Allow group acp-agent-uploads to read buckets in tenancy where target.bucket.name='acp-agent-uploads'
   Allow group acp-agent-uploads to manage objects in tenancy where target.bucket.name='acp-agent-uploads'
   ```

3. A Customer Secret Key for that user.
4. Lifecycle rule: delete objects under `uploads/` after 30 days (until RAG needs them longer).
   Attached but never sent files stay there too.
5. In the app's `.env` (local and on the VM, see [oracle-deployment.md](oracle-deployment.md)),
   then restart the app:

   ```
   UPLOAD_ACCESS_KEY_ID=<access key>
   UPLOAD_SECRET_ACCESS_KEY=<secret key>
   UPLOAD_ENDPOINT=https://<namespace>.compat.objectstorage.mx-queretaro-1.oraclecloud.com
   UPLOAD_BUCKET=acp-agent-uploads
   UPLOAD_REGION=mx-queretaro-1
   ```

   `UPLOAD_PREFIX` defaults to `uploads/`. Local development sets `UPLOAD_PREFIX=uploads-dev/`,
   so its files sit apart from production's in the same bucket (give that folder the same
   lifecycle rule). Until `acp-agent-uploads` exists, the local `.env` points `UPLOAD_*` at
   `acp-agent-files` with the box's key: switch it once the new bucket and key are made.

Nothing changes on the box: it downloads with `curl` and the link, no key. Without these lines
documents cannot be attached: the upload answers 503 and the chip shows "Upload failed" (images
still go to the model as before).

**Checking it.** Attach a file in the chat: the server logs
`[uploads] <conversation> <name> (<n> bytes) → <key in the bucket>`. "Attachments are not
configured on the server" on the chip means the variables are missing. A failed upload shows "Upload failed" on the chip; hover it for Oracle's answer
(`403`: key, region or policy; `404`: bucket or namespace).

## Rotating or removing

Rotate: generate a new secret key for `acp-agent-storage`, replace the two `TIGRIS_` lines on
the box, restart the agent, then delete the old key. Links already handed out stop working,
because they were signed with the old key.

Remove: delete the five lines on the box and restart the agent; delete the key, the user, the
group, the policy and the bucket in the console.
