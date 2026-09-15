import {
  ActionRowBuilder, ApplicationIntegrationType, ButtonBuilder, ButtonStyle, escapeMarkdown,
  InteractionContextType, MessageFlags, PermissionFlagsBits, SlashCommandBuilder,
  type ButtonInteraction, type ChatInputCommandInteraction, type InteractionEditReplyOptions,
} from 'discord.js';
import { PromptError, type PromptJobView, type PromptService } from '../services/PromptService';

type PromptAdapter = Pick<PromptService, 'available' | 'submit' | 'status'>;
type PromptInteraction = ChatInputCommandInteraction | ButtonInteraction;

export const data = new SlashCommandBuilder()
  .setName('prompt').setDescription('Request a shared Linky feature, or check this server’s latest coding request.')
  .setContexts(InteractionContextType.Guild).setIntegrationTypes(ApplicationIntegrationType.GuildInstall)
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addStringOption(option => option.setName('request').setDescription('Describe a feature (public on GitHub). Omit to check the latest request.')
    .setRequired(false).setMinLength(10).setMaxLength(3000));

async function authorize(interaction: PromptInteraction, service?: PromptAdapter): Promise<boolean> {
  const content = !interaction.guildId || !interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)
    ? 'Use /prompt in a server where you have Administrator permission.'
    : !service?.available(interaction.guildId) ? 'Coding requests are not available in this server.' : undefined;
  if (content) {
    await interaction.reply({ content, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
    return false;
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  return true;
}

function plain(value: string): string {
  return escapeMarkdown(value.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').slice(0, 500)).replace(/@/g, '@\u200b');
}

function render(job: PromptJobView): InteractionEditReplyOptions {
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder()
    .setCustomId(`prompt-status:${job.id}`).setLabel('Check status').setStyle(ButtonStyle.Secondary));
  if (job.runUrl && /^https:\/\/github\.com\/LLRHook\/linky\/actions\/runs\/\d+$/.test(job.runUrl)) {
    row.addComponents(new ButtonBuilder().setLabel('Coding run').setStyle(ButtonStyle.Link).setURL(job.runUrl));
  }
  if (job.prUrl && /^https:\/\/github\.com\/LLRHook\/linky\/pull\/\d+$/.test(job.prUrl)) {
    row.addComponents(new ButtonBuilder().setLabel('Pull request').setStyle(ButtonStyle.Link).setURL(job.prUrl));
  }
  return {
    content: `**Request ${job.id}: ${job.state}**\n${plain(job.message)}\n\n` +
      'This request affects the shared Linky bot. The request and coding run are visible on public GitHub.',
    components: [row], allowedMentions: { parse: [] },
  };
}

function failure(error: unknown): InteractionEditReplyOptions {
  return { content: error instanceof PromptError ? plain(error.message)
    : 'Could not complete the coding request. Run /prompt without a request to check its status before submitting again.',
  components: [], allowedMentions: { parse: [] } };
}

export async function execute(interaction: ChatInputCommandInteraction, service?: PromptAdapter): Promise<void> {
  if (!await authorize(interaction, service)) return;
  const input = interaction.options.getString('request');
  if (input === null) {
    try { await interaction.editReply(render(await service!.status(undefined, interaction.guildId!))); }
    catch (error) { await interaction.editReply(failure(error)); }
    return;
  }
  const request = input.trim();
  if (request.length < 10 || request.length > 3000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/.test(request)) {
    await interaction.editReply({ content: 'Describe the feature in 10–3,000 characters, without control characters.',
      allowedMentions: { parse: [] } });
    return;
  }
  try {
    await interaction.editReply(render(await service!.submit({ id: interaction.id, guildId: interaction.guildId!,
      userId: interaction.user.id, request })));
  } catch (error) { await interaction.editReply(failure(error)); }
}

export async function handleStatus(interaction: ButtonInteraction, service?: PromptAdapter): Promise<boolean> {
  if (!interaction.customId.startsWith('prompt-status:')) return false;
  if (!await authorize(interaction, service)) return true;
  const id = interaction.customId.slice('prompt-status:'.length);
  if (!/^\d{17,20}$/.test(id)) {
    await interaction.editReply({ content: 'This coding request ID is invalid.', allowedMentions: { parse: [] } });
    return true;
  }
  try { await interaction.editReply(render(await service!.status(id, interaction.guildId!))); }
  catch (error) { await interaction.editReply(failure(error)); }
  return true;
}
