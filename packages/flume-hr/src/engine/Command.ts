import { existsSync, writeFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";

export interface InvokeResult {
  success: boolean;
  message: string;
  filePath?: string;
  /** Structured lifecycle outcome. Message text is presentation only. */
  outcome?: "changed" | "unchanged" | "planned" | "skipped" | "failed" | "cancelled";
}

export interface CommandContext {
  targetDir: string;
  force?: boolean;
  dryRun?: boolean;
  /** Suppress presentation output when a structured caller owns stdout. */
  quiet?: boolean;
}

export abstract class Command {
  protected context: CommandContext;

  constructor(context: CommandContext) {
    this.context = context;
  }

  abstract invoke(): Promise<InvokeResult>;

  /**
   * Format message with [DRY RUN] prefix if in dry-run mode
   */
  protected formatMessage(message: string): string {
    return this.context.dryRun ? `[DRY RUN] ${message}` : message;
  }

  protected fileExists(filePath: string): boolean {
    const fullPath = join(this.context.targetDir, filePath);
    return existsSync(fullPath);
  }

  protected writeFile(filePath: string, content: string): void {
    // Skip file writing in dry-run mode
    if (this.context.dryRun) {
      return;
    }

    const fullPath = join(this.context.targetDir, filePath);
    const dir = dirname(fullPath);

    mkdirSync(dir, { recursive: true });
    writeFileSync(fullPath, content);
  }

  protected createDirectory(dirPath: string): void {
    // Skip directory creation in dry-run mode
    if (this.context.dryRun) {
      return;
    }

    const fullPath = join(this.context.targetDir, dirPath);
    mkdirSync(fullPath, { recursive: true });
  }
}
