# YouTube layout: one message

Researched September 11, 2026. The user selected the single-message player and controls after reviewing the tradeoff below. A live Discord REST probe confirmed that a legacy action row preserves the native YouTube video embed.

The current screenshot feels fragmented because it repeats Linky's author header, a red embed border, and a YouTube heading. The player and its metadata should read as one object. Posting the companion message immediately might group its author header, but that leaves two cards and depends on client grouping.

## What Discord supports

- Legacy action rows can accompany ordinary `content` and `embeds` without `IS_COMPONENTS_V2`. Discord continues to support this mode. One row can contain up to five buttons; button labels are limited to 80 characters. This supports a native URL message with a compact control row. The documentation does not promise exact client geometry or explicitly demonstrate a YouTube unfurl with buttons, so verify the result in Discord. [Component reference](https://docs.discord.com/developers/components/reference#legacy-message-component-behavior)
- Components V2 disables ordinary content and embeds. It enables ordered text, media, and containers, but cannot host the existing native embed through the `embeds` field. [Components overview](https://docs.discord.com/developers/components/overview)
- Media Gallery accepts media items, and the media-item definition requires a direct link to the asset or an uploaded attachment. A YouTube watch-page URL is not a documented direct video asset. Do not promise playback by inserting that page into a gallery. [Media Gallery and Unfurled Media Item](https://docs.discord.com/developers/components/reference#media-gallery)
- Bot-created embeds are rich embeds. The API excludes developer-supplied `type`, `provider`, and `video`. Copying the returned native YouTube embed and inserting custom fields is therefore not a supported way to retain its player. The documented message schema offers no field for ordinary text positioned after an automatic embed. This is a conclusion from the supported schema, rather than an explicit Discord statement about every client's rendering. [Message resource](https://docs.discord.com/developers/resources/message)
- A button can trigger an interaction response marked `EPHEMERAL`, visible only to the person who clicked. Respond or defer within three seconds; interaction tokens last 15 minutes. A component response may contain normal text and embeds. [Interaction responses](https://docs.discord.com/developers/interactions/receiving-and-responding)

## Recommended presentation

Keep one native YouTube message and add one compact row beneath its player:

`20.7K views · 328 likes · 57 comments`  `Top comment`

Combine the counts into one readable button so the row stays compact. Clicking opens exact recent counts privately. The comment button opens the excerpt, its author, and a YouTube link privately. Use enabled secondary buttons; disabled gray count buttons could recreate the visibility complaint. These controls do not like or comment on YouTube. Reserve unrelated Original post and Remove controls for their owner in a separate row of the same message.

This preserves native playback, removes the companion card and second author header, and makes extra reading optional. The comment is one click away, as described in the proposal the user accepted. If no comment is available, omit that button rather than creating an empty interaction.

Keep handlers available after restarts. Limit comment lookups, respect the existing API-data expiration policy, and remove expired count controls without deleting the player. Do not rely on an in-memory component collector that silently expires while buttons remain visible. Preserve source-removal and rollback behavior.

## Alternative when the comment must stay visible

Use one Components V2 container: title/channel, YouTube thumbnail, a compact count line, then comment and author, followed by an Open YouTube button. This gives deliberate reading order and one visual boundary. It sacrifices the native in-Discord YouTube player; clicking opens YouTube. It is a product tradeoff, not an equivalent playback implementation.

A two-message player-plus-card can keep both native playback and a visible comment, but retains the split the user dislikes. Removing its redundant title and using less spacing only reduces that problem.

## Verification before shipping

Confirm the live native embed survives adding and editing legacy components; inspect desktop and narrow/mobile layout; click every control; check exact counts, author escaping, and unavailable-comment behavior; restart the bot and retest controls; then exercise expiration and source removal. An API payload accepted by Discord is not by itself proof of good visual layout or working playback.
