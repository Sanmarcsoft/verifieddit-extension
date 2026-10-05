# Multi-ingredient fixture (#184)

`composite.jpg` is `a-base.jpg` with its contrast changed and `b-added.jpg` pasted in.

All three are signed by the Trusteddit signing service on the development lane
(trusted, timestamped, durable, declared as generated artwork). The composite was
signed with its two sources uploaded as ingredient files
(trusteddit-pki-services#434), so each source keeps its own credentials inside it:
`a-base.jpg` as `parentOf`, `b-added.jpg` as `componentOf`, with `c2pa.opened` and
`c2pa.placed` actions naming them.

`composite.store.json` is the manifest store c2patool 0.26.7 reads from
`composite.jpg`, with thumbnails and certificate chains removed.

To regenerate: `SignMedia.ts sign a-base.jpg b-added.jpg --lane=development`, then
`SignMedia.ts sign composite.jpg --lane=development --parent=a-base.jpg --ingredient=b-added.jpg`.
