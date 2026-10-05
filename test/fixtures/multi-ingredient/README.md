# Multi-ingredient fixture (#184)

`composite.jpg` is `a-base.jpg` with its contrast changed and `b-added.jpg` pasted in.

- `a-base.jpg` and `b-added.jpg` are signed by the Trusteddit signing service on the
  development lane (trusted, durable, declared as generated artwork).
- `composite.jpg` is signed with c2pa-node's public test signer, because the signing
  service cannot attach ingredient files yet (trusteddit-pki-services#434). Its signer
  is therefore untrusted; its two ingredients carry their own Trusteddit credentials,
  `a-base.jpg` as `parentOf` and `b-added.jpg` as `componentOf`.
- `composite.store.json` is the manifest store c2patool 0.26.7 reads from
  `composite.jpg`, with thumbnails and certificate chains removed.

Replace `composite.jpg` with one signed by our own PKI once #434 ships.
