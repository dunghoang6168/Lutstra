import { Component, ElementRef, OnDestroy, ViewChild, afterNextRender, computed, signal } from '@angular/core';
import { IconComponent } from '../icon/icon.component';
import {
  AndroidFolderNode, FolderGrant, FolderRule, androidFolders, childrenOf, folderCheckState, folderPickerRequest,
  selectedBranches, toggleFolder,
} from '../../../core/android/android-folder-selection';

interface FolderRow {
  node: AndroidFolderNode;
  depth: number;
  state: 'checked' | 'mixed' | 'unchecked';
  hasChildren: boolean;
  expanded: boolean;
  grant: FolderGrant | null;
}

/**
 * Android scan scope, shown while `folderPickerRequest` is set. Ticks are a draft until Save & scan;
 * removing access to a granted tree applies at once, so closing afterwards still asks for a scan.
 */
@Component({
  selector: 'app-android-folder-picker',
  standalone: true,
  imports: [IconComponent],
  templateUrl: './android-folder-picker.component.html',
  styleUrl: './android-folder-picker.component.scss',
})
export class AndroidFolderPickerComponent implements OnDestroy {
  readonly nodes = signal<AndroidFolderNode[]>([]);
  readonly grants = signal<FolderGrant[]>([]);
  readonly rules = signal<FolderRule[]>([]);
  readonly expanded = signal<Set<string>>(new Set());
  readonly busy = signal(true);
  readonly error = signal<string | null>(null);
  readonly pendingRelease = signal<{ grant: FolderGrant; name: string } | null>(null);
  readonly branchCount = computed(() => selectedBranches(this.nodes(), this.rules()).length);
  readonly rows = computed(() => {
    const nodes = this.nodes();
    const rules = this.rules();
    const expanded = this.expanded();
    const grants = new Map(this.grants().map(grant => [grant.key, grant]));
    const rows: FolderRow[] = [];
    const walk = (parentKey: string | null, depth: number): void => {
      for (const node of childrenOf(nodes, parentKey)) {
        const hasChildren = childrenOf(nodes, node.key).length > 0;
        rows.push({ node, depth, state: folderCheckState(nodes, rules, node.key), hasChildren,
          expanded: expanded.has(node.key), grant: grants.get(node.key) ?? null });
        if (hasChildren && expanded.has(node.key)) walk(node.key, depth + 1);
      }
    };
    walk(null, 0);
    return rows;
  });

  @ViewChild('dialog') private dialog?: ElementRef<HTMLDialogElement>;
  private focusBeforeDialog: HTMLElement | null = null;
  private grantsChanged = false;

  constructor() {
    afterNextRender(() => {
      this.focusBeforeDialog = document.activeElement as HTMLElement | null;
      this.dialog?.nativeElement.showModal();
    });
    void this.load(true);
  }

  ngOnDestroy(): void {
    this.dialog?.nativeElement.close();
    if (this.focusBeforeDialog?.isConnected) this.focusBeforeDialog.focus();
  }

  async addFolder(): Promise<void> {
    await this.run(async () => {
      let chosen: { key: string };
      try {
        chosen = await androidFolders.choose();
      } catch (error) {
        if (String(error).includes('FOLDER_SELECTION_CANCELLED')) return;
        throw error;
      }
      this.grantsChanged = true;
      await this.load(false);
      this.rules.update(rules => toggleFolder(this.nodes(), rules, chosen.key, true));
      this.expandTo(chosen.key);
    });
  }

  toggleExpanded(key: string): void {
    this.expanded.update(current => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }

  toggleCheck(key: string, event: Event): void {
    const selected = (event.target as HTMLInputElement).checked;
    this.rules.update(rules => toggleFolder(this.nodes(), rules, key, selected));
  }

  async releaseGrant(): Promise<void> {
    const grant = this.pendingRelease()?.grant;
    if (!grant) return;
    await this.run(async () => {
      await androidFolders.releaseGrant({ treeUri: grant.treeUri });
      this.grantsChanged = true;
      this.pendingRelease.set(null);
      await this.load(false);
    });
  }

  async save(): Promise<void> {
    await this.run(async () => {
      await androidFolders.saveSelection({ rules: this.rules() });
      this.close(true);
    });
  }

  cancel(): void {
    if (this.pendingRelease()) { this.pendingRelease.set(null); return; }
    this.close(this.grantsChanged);
  }

  onCancel(event: Event): void {
    event.preventDefault();
    this.cancel();
  }

  onKeyDown(event: KeyboardEvent): void {
    // Keep global player/search shortcuts outside the modal's focus scope.
    event.stopPropagation();
    if (event.key === 'Escape') this.onCancel(event);
  }

  onBackdropClick(event: MouseEvent): void {
    const dialog = this.dialog?.nativeElement;
    if (!dialog || event.target !== dialog) return;
    const bounds = dialog.getBoundingClientRect();
    if (event.clientX < bounds.left || event.clientX > bounds.right ||
      event.clientY < bounds.top || event.clientY > bounds.bottom) this.cancel();
  }

  /** Reloads the granted trees; the draft ticks survive a reload. */
  private async load(initial: boolean): Promise<void> {
    const work = async () => {
      const [tree, selection] = await Promise.all([androidFolders.listTree(), androidFolders.getSelection()]);
      this.nodes.set(tree.folders);
      this.grants.set(tree.grants ?? []);
      if (initial) {
        this.rules.set(selection.rules);
        this.expanded.set(new Set(childrenOf(tree.folders, null).map(node => node.key)));
      }
    };
    if (initial) await this.run(work); else await work();
  }

  private expandTo(key: string): void {
    const byKey = new Map(this.nodes().map(node => [node.key, node]));
    const keys = new Set(this.expanded());
    for (let current: string | null = key; current && !keys.has(current); current = byKey.get(current)?.parentKey ?? null) {
      keys.add(current);
    }
    this.expanded.set(keys);
  }

  private async run(work: () => Promise<void>): Promise<void> {
    this.busy.set(true);
    this.error.set(null);
    try {
      await work();
    } catch (error) {
      this.error.set(error instanceof Error ? error.message : String(error));
    } finally {
      this.busy.set(false);
    }
  }

  private close(changed: boolean): void {
    const resolve = folderPickerRequest();
    folderPickerRequest.set(null);
    resolve?.(changed);
  }
}
