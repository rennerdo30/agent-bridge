/** Completed final answers in one run; live status and sibling acknowledgements cannot erase them. */
export class FinalAnswers {
  private readonly finals = new Map<string, string>();
  private readonly unphased = new Map<string, string>();
  private lastMessage = "";

  add(item: { id?: string; text: string; phase?: string | null }): void {
    if (!item.text.trim()) return;
    this.lastMessage = item.text;
    const messages = item.phase === "final_answer" ? this.finals : item.phase ? null : this.unphased;
    messages?.set(item.id ?? String(messages.size), item.text);
  }

  text(): string {
    const messages = this.finals.size ? this.finals : this.unphased;
    return messages.size ? [...messages.values()].join("\n\n") : this.lastMessage;
  }
}
