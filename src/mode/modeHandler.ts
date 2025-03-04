import * as vscode from 'vscode';

import { BaseAction, KeypressState, BaseCommand, getRelevantAction } from './../actions/base';
import { BaseMovement } from '../actions/baseMotion';
import {
  CommandEscInsertMode,
  CommandInsertInInsertMode,
  CommandInsertPreviousText,
} from './../actions/commands/insert';
import { Jump } from '../jumps/jump';
import { Logger } from '../util/logger';
import { Mode, VSCodeVimCursorType, isVisualMode, getCursorStyle, isStatusBarMode } from './mode';
import { PairMatcher } from './../common/matching/matcher';
import { laterOf } from './../common/motion/position';
import { Range } from './../common/motion/range';
import { IBaseAction, RecordedState } from './../state/recordedState';
import { Register, RegisterMode } from './../register/register';
import { Remappers } from '../configuration/remapper';
import { StatusBar } from '../statusBar';
import { TextEditor } from './../textEditor';
import { VimError, ForceStopRemappingError } from './../error';
import { VimState } from './../state/vimState';
import { VSCodeContext } from '../util/vscodeContext';
import { commandLine } from '../cmd_line/commandLine';
import { configuration } from '../configuration/configuration';
import { decoration } from '../configuration/decoration';
import { scrollView } from '../util/util';
import {
  CommandQuitRecordMacro,
  DocumentContentChangeAction,
  ActionOverrideCmdD,
  CommandNumber,
} from './../actions/commands/actions';
import { isTextTransformation } from '../transformations/transformations';
import { executeTransformations, IModeHandler } from '../transformations/execute';
import { globalState } from '../state/globalState';
import { Notation } from '../configuration/notation';
import { EditorIdentity } from '../editorIdentity';
import { SpecialKeys } from '../util/specialKeys';
import { BaseOperator } from '../actions/operator';
import { SearchByNCharCommand } from '../actions/plugins/easymotion/easymotion.cmd';
import { Position } from 'vscode';
import { RemapState } from '../state/remapState';
import * as process from 'process';
import { EasyMotion } from '../actions/plugins/easymotion/easymotion';

interface IModeHandlerMap {
  get(editorId: EditorIdentity): ModeHandler | undefined;
}

/**
 * ModeHandler is the extension's backbone. It listens to events and updates the VimState.
 * One of these exists for each editor - see ModeHandlerMap
 *
 * See:  https://github.com/VSCodeVim/Vim/blob/master/.github/CONTRIBUTING.md#the-vim-state-machine
 */
export class ModeHandler implements vscode.Disposable, IModeHandler {
  public readonly vimState: VimState;
  public readonly remapState: RemapState;

  private readonly disposables: vscode.Disposable[] = [];
  private readonly handlerMap: IModeHandlerMap;
  private readonly remappers: Remappers;
  private static readonly logger = Logger.get('ModeHandler');

  // TODO: clarify the difference between ModeHandler.currentMode and VimState.currentMode
  private _currentMode: Mode;

  get currentMode(): Mode {
    return this._currentMode;
  }

  private async setCurrentMode(modeName: Mode): Promise<void> {
    await this.vimState.setCurrentMode(modeName);
    this._currentMode = modeName;
  }

  public static async create(
    handlerMap: IModeHandlerMap,
    textEditor = vscode.window.activeTextEditor!
  ): Promise<ModeHandler> {
    const modeHandler = new ModeHandler(handlerMap, textEditor);
    await modeHandler.vimState.load();
    await modeHandler.setCurrentMode(configuration.startInInsertMode ? Mode.Insert : Mode.Normal);
    modeHandler.syncCursors();
    return modeHandler;
  }

  private constructor(handlerMap: IModeHandlerMap, textEditor: vscode.TextEditor) {
    this.handlerMap = handlerMap;
    this.remappers = new Remappers();

    this.vimState = new VimState(textEditor, new EasyMotion());
    this.remapState = new RemapState();
    this.disposables.push(this.vimState);
  }

  /**
   * Updates VSCodeVim's internal representation of cursors to match VSCode's selections.
   * This loses some information, so it should only be done when necessary.
   */
  public syncCursors() {
    // TODO: getCursorsAfterSync() is basically this, but stupider
    if (this.vimState.editor) {
      const { selections } = this.vimState.editor;
      if (
        !this.vimState.cursorStartPosition.isEqual(selections[0].anchor) ||
        !this.vimState.cursorStopPosition.isEqual(selections[0].active)
      ) {
        this.vimState.desiredColumn = selections[0].active.character;
      }

      this.vimState.cursors = selections.map(({ active, anchor }) =>
        active.isBefore(anchor) ? new Range(anchor.getLeft(), active) : new Range(anchor, active)
      );
    }
  }

  /**
   * This is easily the worst function in VSCodeVim.
   *
   * We need to know when VSCode has updated our selection, so that we can sync
   * that internally. Unfortunately, VSCode has a habit of calling this
   * function at weird times, or or with incomplete information, so we have to
   * do a lot of voodoo to make sure we're updating the cursors correctly.
   *
   * Even worse, we don't even know how to test this stuff.
   *
   * Anyone who wants to change the behavior of this method should make sure
   * all selection related test cases pass. Follow this spec
   * https://gist.github.com/rebornix/d21d1cc060c009d4430d3904030bd4c1 to
   * perform the manual testing. Besides this testing you should still test
   * commands like 'editor.action.smartSelect.grow' and you should test moving
   * continuously up/down or left/right with and without remapped movement keys
   * because sometimes vscode lags behind and calls this function with information
   * that is not up to date with our selections yet and we need to make sure we don't
   * change our cursors to previous information (this usally is only an issue in visual
   * mode because of our different ways of handling selections and in those cases
   * updating our cursors with not up to date info might result in us changing our
   * cursor start position).
   */
  public async handleSelectionChange(e: vscode.TextEditorSelectionChangeEvent): Promise<void> {
    if (
      vscode.window.activeTextEditor === undefined ||
      e.textEditor.document !== vscode.window.activeTextEditor.document
    ) {
      // we don't care if there is no active editor
      // or user selection changed in a paneled window (e.g debug console/terminal)
      // This check is made before enqueuing this selection change, but sometimes
      // between the enqueueing and the actual calling of this function the editor
      // might close or change to other document
      return;
    }
    const selection = e.selections[0];
    ModeHandler.logger.debug(
      `Selections: Handling Selection Change! Selection: ${selection.anchor.toString()}, ${
        selection.active
      }, SelectionsLength: ${e.selections.length}`
    );

    // If our previous cursors are not included on any of the current selections, then a snippet
    // must have been inserted.
    const isSnippetSelectionChange = () => {
      return e.selections.every((s) => {
        return this.vimState.cursors.every((c) => !s.contains(new vscode.Range(c.start, c.stop)));
      });
    };

    if (
      (e.selections.length !== this.vimState.cursors.length || this.vimState.isMultiCursor) &&
      this.vimState.currentMode !== Mode.VisualBlock
    ) {
      const allowedModes = [Mode.Normal];
      if (!isSnippetSelectionChange()) {
        allowedModes.push(...[Mode.Insert, Mode.Replace]);
      }
      // Number of selections changed, make sure we know about all of them still
      this.vimState.cursors = e.textEditor.selections.map(
        (sel) =>
          new Range(
            // Adjust the cursor positions because cursors & selections don't match exactly
            sel.anchor.isAfter(sel.active) ? sel.anchor.getLeft() : sel.anchor,
            sel.active
          )
      );
      if (
        e.selections.some((s) => !s.anchor.isEqual(s.active)) &&
        allowedModes.includes(this.vimState.currentMode)
      ) {
        // If we got a visual selection and we are on normal, insert or replace mode, enter visual mode.
        // We shouldn't go to visual mode on any other mode, because the other visual modes are handled
        // very differently than vscode so only our extension will create them. And the other modes
        // like the plugin modes shouldn't be changed or else it might mess up the plugins actions.
        await this.setCurrentMode(Mode.Visual);
      }
      return this.updateView({ drawSelection: false, revealRange: false });
    }

    /**
     * We only trigger our view updating process if it's a mouse selection.
     * Otherwise we only update our internal cursor positions accordingly.
     */
    if (e.kind !== vscode.TextEditorSelectionChangeKind.Mouse) {
      if (selection) {
        if (e.kind === vscode.TextEditorSelectionChangeKind.Command) {
          // This 'Command' kind is triggered when using a command like 'editor.action.smartSelect.grow'
          // but it is also triggered when we set the 'editor.selections' on 'updateView'.
          const allowedModes = [Mode.Normal, Mode.Visual];
          if (!isSnippetSelectionChange()) {
            // if we just inserted a snippet then don't allow insert modes to go to visual mode
            allowedModes.push(...[Mode.Insert, Mode.Replace]);
          }
          if (allowedModes.includes(this.vimState.currentMode)) {
            // Since the selections weren't ignored then probably we got change of selection from
            // a command, so we need to update our start and stop positions. This is where commands
            // like 'editor.action.smartSelect.grow' are handled.
            if (this.vimState.currentMode === Mode.Visual) {
              ModeHandler.logger.debug('Selections: Updating Visual Selection!');
              this.vimState.cursorStopPosition = selection.active;
              this.vimState.cursorStartPosition = selection.anchor;
              await this.updateView({ drawSelection: false, revealRange: false });
              return;
            } else if (!selection.active.isEqual(selection.anchor)) {
              ModeHandler.logger.debug('Selections: Creating Visual Selection from command!');
              this.vimState.cursorStopPosition = selection.active;
              this.vimState.cursorStartPosition = selection.anchor;
              await this.setCurrentMode(Mode.Visual);
              await this.updateView({ drawSelection: false, revealRange: false });
              return;
            }
          }
        }
        // Here we are on the selection changed of kind 'Keyboard' or 'undefined' which is triggered
        // when pressing movement keys that are not caught on the 'type' override but also when using
        // commands like 'cursorMove'.

        if (isVisualMode(this.vimState.currentMode)) {
          /**
           * In Visual Mode, our `cursorPosition` and `cursorStartPosition` can not reflect `active`,
           * `start`, `end` and `anchor` information in a selection.
           * See `Fake block cursor with text decoration` section of `updateView` method.
           * Besides this, sometimes on visual modes our start position is not the same has vscode
           * anchor because we need to move vscode anchor one to the right of our start when our start
           * is after our stop in order to include the start character on vscodes selection.
           */
          return;
        }

        const cursorEnd = laterOf(
          this.vimState.cursorStartPosition,
          this.vimState.cursorStopPosition
        );
        if (e.textEditor.document.validatePosition(cursorEnd).isBefore(cursorEnd)) {
          // The document changed such that our cursor position is now out of bounds, possibly by
          // another program. Let's just use VSCode's selection.
          // TODO: if this is the case, but we're in visual mode, we never get here (because of branch above)
        } else if (
          this.vimState.cursorStopPosition.isEqual(this.vimState.cursorStartPosition) &&
          this.vimState.cursorStopPosition.getRight().isLineEnd() &&
          this.vimState.cursorStopPosition.getLineEnd().isEqual(selection.active)
        ) {
          // We get here when we use a 'cursorMove' command (that is considered a selection changed
          // kind of 'Keyboard') that ends past the line break. But our cursors are already on last
          // character which is what we want. Even though our cursors will be corrected again when
          // checking if they are in bounds on 'runAction' there is no need to be changing them back
          // and forth so we check for this situation here.
          return;
        }

        // Here we allow other 'cursorMove' commands to update our cursors in case there is another
        // extension making cursor changes that we need to catch.
        //
        // We still need to be careful with this because this here might be changing our cursors
        // in ways we don't want to. So with future selection issues this is a good place to start
        // looking.
        ModeHandler.logger.debug(
          `Selections: Changing Cursors from selection handler... ${selection.anchor.toString()}, ${
            selection.active
          }`
        );
        this.vimState.cursorStopPosition = selection.active;
        this.vimState.cursorStartPosition = selection.anchor;
        await this.updateView({ drawSelection: false, revealRange: false });
      }
      return;
    }

    if (e.selections.length === 1) {
      this.vimState.isMultiCursor = false;
    }

    if (isStatusBarMode(this.vimState.currentMode)) {
      return;
    }

    let toDraw = false;

    if (selection) {
      let newPosition = selection.active;

      // Only check on a click, not a full selection (to prevent clicking past EOL)
      if (newPosition.character >= newPosition.getLineEnd().character && selection.isEmpty) {
        if (this.vimState.currentMode !== Mode.Insert) {
          this.vimState.lastClickWasPastEol = true;

          // This prevents you from mouse clicking past the EOL
          newPosition = newPosition.withColumn(Math.max(newPosition.getLineEnd().character - 1, 0));

          // Switch back to normal mode since it was a click not a selection
          await this.setCurrentMode(Mode.Normal);

          toDraw = true;
        }
      } else if (selection.isEmpty) {
        this.vimState.lastClickWasPastEol = false;
      }

      this.vimState.cursorStopPosition = newPosition;
      this.vimState.cursorStartPosition = newPosition;
      this.vimState.desiredColumn = newPosition.character;

      // start visual mode?
      if (
        selection.anchor.line === selection.active.line &&
        selection.anchor.character >= newPosition.getLineEnd().character - 1 &&
        selection.active.character >= newPosition.getLineEnd().character - 1
      ) {
        // This prevents you from selecting EOL
      } else if (!selection.anchor.isEqual(selection.active)) {
        let selectionStart = new Position(selection.anchor.line, selection.anchor.character);

        if (selectionStart.character > selectionStart.getLineEnd().character) {
          selectionStart = new Position(selectionStart.line, selectionStart.getLineEnd().character);
        }

        this.vimState.cursorStartPosition = selectionStart;

        if (selectionStart.isAfter(newPosition)) {
          this.vimState.cursorStartPosition = this.vimState.cursorStartPosition.getLeft();
        }

        // If we prevented from clicking past eol but it is part of this selection, include the last char
        if (this.vimState.lastClickWasPastEol) {
          const newStart = new Position(selection.anchor.line, selection.anchor.character + 1);
          this.vimState.editor.selection = new vscode.Selection(newStart, selection.end);
          this.vimState.cursorStartPosition = selectionStart;
          this.vimState.lastClickWasPastEol = false;
        }

        if (
          configuration.mouseSelectionGoesIntoVisualMode &&
          !isVisualMode(this.vimState.currentMode) &&
          this.currentMode !== Mode.Insert
        ) {
          await this.setCurrentMode(Mode.Visual);

          // double click mouse selection causes an extra character to be selected so take one less character
        }
      } else if (this.vimState.currentMode !== Mode.Insert) {
        await this.setCurrentMode(Mode.Normal);
      }

      this.updateView({ drawSelection: toDraw, revealRange: false });
    }
  }

  async handleMultipleKeyEvents(keys: string[]): Promise<void> {
    for (const key of keys) {
      await this.handleKeyEvent(key);
    }
  }

  public async handleKeyEvent(key: string): Promise<void> {
    const now = Number(new Date());
    const printableKey = Notation.printableKey(key, configuration.leader);

    // Check forceStopRemapping
    if (this.remapState.forceStopRecursiveRemapping) {
      return;
    }

    ModeHandler.logger.debug(`handling key=${printableKey}.`);

    if (
      (key === SpecialKeys.TimeoutFinished ||
        this.vimState.recordedState.bufferedKeys.length > 0) &&
      this.vimState.recordedState.bufferedKeysTimeoutObj
    ) {
      // Handle the bufferedKeys or append the new key to the previously bufferedKeys
      clearTimeout(this.vimState.recordedState.bufferedKeysTimeoutObj);
      this.vimState.recordedState.bufferedKeysTimeoutObj = undefined;
      this.vimState.recordedState.commandList = [...this.vimState.recordedState.bufferedKeys];
      this.vimState.recordedState.bufferedKeys = [];
    }

    // rewrite copy
    if (configuration.overrideCopy) {
      // The conditions when you trigger a "copy" rather than a ctrl-c are
      // too sophisticated to be covered by the "when" condition in package.json
      if (key === '<D-c>') {
        key = '<copy>';
      }

      if (key === '<C-c>' && process.platform !== 'darwin') {
        if (
          !configuration.useCtrlKeys ||
          this.vimState.currentMode === Mode.Visual ||
          this.vimState.currentMode === Mode.VisualBlock ||
          this.vimState.currentMode === Mode.VisualLine
        ) {
          key = '<copy>';
        }
      }
    }

    // <C-d> triggers "add selection to next find match" by default,
    // unless users explicity make <C-d>: true
    if (key === '<C-d>' && !(configuration.handleKeys['<C-d>'] === true)) {
      key = '<D-d>';
    }

    this.vimState.cursorsInitialState = this.vimState.cursors;
    this.vimState.recordedState.commandList.push(key);

    const oldMode = this.vimState.currentMode;
    const oldFullMode = this.vimState.currentModeIncludingPseudoModes;
    const oldStatusBarText = StatusBar.getText();
    const oldWaitingForAnotherActionKey = this.vimState.recordedState.waitingForAnotherActionKey;

    let handledAsRemap = false;
    let handledAsAction = false;
    try {
      // Handling special case for '0'. From Vim documentation (:help :map-modes)
      // Special case: While typing a count for a command in Normal mode, mapping zero
      // is disabled. This makes it possible to map zero without making it impossible
      // to type a count with a zero.
      const preventZeroRemap =
        key === '0' && this.vimState.recordedState.getLastActionRun() instanceof CommandNumber;

      // Check for remapped keys if:
      // 1. We are not currently performing a non-recursive remapping
      // 2. We are not typing '0' after starting to type a count
      // 3. We are not waiting for another action key
      //    Example: jj should not remap the second 'j', if jj -> <Esc> in insert mode
      //             0 should not be remapped if typed after another number, like 10
      //             for actions with multiple keys like 'gg' or 'fx' the second character
      //           shouldn't be mapped
      if (
        !this.remapState.isCurrentlyPerformingNonRecursiveRemapping &&
        !preventZeroRemap &&
        !this.vimState.recordedState.waitingForAnotherActionKey
      ) {
        handledAsRemap = await this.remappers.sendKey(
          this.vimState.recordedState.commandList,
          this
        );
      }

      this.vimState.recordedState.allowPotentialRemapOnFirstKey = true;

      if (!handledAsRemap) {
        if (key === SpecialKeys.TimeoutFinished) {
          // Remove the <TimeoutFinished> key and get the key before that. If the <TimeoutFinished>
          // key was the last key, then 'key' will be undefined and won't be sent to handle action.
          this.vimState.recordedState.commandList.pop();
          key =
            this.vimState.recordedState.commandList[
              this.vimState.recordedState.commandList.length - 1
            ];
        }
        if (key !== undefined) {
          handledAsAction = await this.handleKeyAsAnAction(key);
        }
      }
    } catch (e) {
      this.vimState.selectionsChanged.ignoreIntermediateSelections = false;
      if (e instanceof VimError) {
        StatusBar.displayError(this.vimState, e);
        this.vimState.recordedState = new RecordedState();
        if (this.remapState.isCurrentlyPerformingRemapping) {
          // If we are handling a remap and we got a VimError stop handling the remap
          // and discard the rest of the keys. We throw an Exception here to stop any other
          // remapping handling steps and go straight to the 'finally' step of the remapper.
          throw ForceStopRemappingError.fromVimError(e);
        }
      } else if (e instanceof ForceStopRemappingError) {
        // If this is a ForceStopRemappingError rethrow it until it gets to the remapper
        throw e;
      } else if (e instanceof Error) {
        e.message = `Failed to handle key=${key}. ${e.message}`;
        throw e;
      } else {
        throw new Error(`Failed to handle key=${key} due to an unknown error.`);
      }
    }

    this.remapState.lastKeyPressedTimestamp = now;

    StatusBar.updateShowCmd(this.vimState);

    // We don't want to immediately erase any message that resulted from the action just performed
    if (StatusBar.getText() === oldStatusBarText) {
      // Clear the status bar of high priority messages if the mode has changed, the view has scrolled
      // or it is recording a Macro
      const forceClearStatusBar =
        (this.vimState.currentMode !== oldMode && this.vimState.currentMode !== Mode.Normal) ||
        this.vimState.macro !== undefined;
      StatusBar.clear(this.vimState, forceClearStatusBar);
    }

    // We either already ran an action or we have a potential action to run but
    // the key is already stored on 'actionKeys' in that case we don't need it
    // anymore on commandList that is only used for the remapper and 'showCmd'
    // and both had already been handled at this point.
    // If we got here it means that there is no potential remap for the key
    // either so we need to clear it from commandList so that it doesn't interfere
    // with the next remapper check.
    this.vimState.recordedState.resetCommandList();

    ModeHandler.logger.debug(
      `handleKeyEvent('${printableKey}') took ${Number(new Date()) - now}ms`
    );

    // If we are handling a remap and the last movement failed stop handling the remap
    // and discard the rest of the keys. We throw an Exception here to stop any other
    // remapping handling steps and go straight to the 'finally' step of the remapper.
    if (this.remapState.isCurrentlyPerformingRemapping && this.vimState.lastMovementFailed) {
      this.vimState.lastMovementFailed = false;
      throw new ForceStopRemappingError('Last movement failed');
    }

    // Reset lastMovementFailed. Anyone who needed it has probably already handled it.
    // And keeping it past this point would make any following remapping force stop.
    this.vimState.lastMovementFailed = false;

    if (!handledAsAction) {
      // There was no action run yet but we still want to update the view to be able
      // to show the potential remapping keys being pressed, the `"` character when
      // waiting on a register key or the `?` character and any following character
      // when waiting on digraph keys. The 'oldWaitingForAnotherActionKey' is used
      // to call the updateView after we are no longer waiting keys so that any
      // existing overlapped key is removed.
      if (
        ((this.vimState.currentMode === Mode.Insert ||
          this.vimState.currentMode === Mode.Replace) &&
          (this.vimState.recordedState.bufferedKeys.length > 0 ||
            this.vimState.recordedState.waitingForAnotherActionKey ||
            this.vimState.recordedState.waitingForAnotherActionKey !==
              oldWaitingForAnotherActionKey)) ||
        this.vimState.currentModeIncludingPseudoModes !== oldFullMode
      ) {
        // TODO: this call to updateView is only used to update the virtualCharacter and halfBlock
        // cursor decorations, if in the future we split up the updateView function there should
        // be no need to call all of it.
        await this.updateView({ drawSelection: false, revealRange: false });
      }
    }
  }

  private async handleKeyAsAnAction(key: string): Promise<boolean> {
    if (vscode.window.activeTextEditor !== this.vimState.editor) {
      ModeHandler.logger.warn('Current window is not active');
      return false;
    }

    // Catch any text change not triggered by us (example: tab completion).
    this.vimState.historyTracker.addChange(this.vimState.cursorsInitialState.map((c) => c.stop));

    this.vimState.keyHistory.push(key);

    const recordedState = this.vimState.recordedState;
    recordedState.actionKeys.push(key);

    const action = getRelevantAction(recordedState.actionKeys, this.vimState);
    switch (action) {
      case KeypressState.NoPossibleMatch:
        if (this.vimState.currentMode === Mode.Insert) {
          this.vimState.recordedState.actionKeys = [];
        } else {
          this.vimState.recordedState = new RecordedState();
        }
        // Since there is no possible action we are no longer waiting any action keys
        this.vimState.recordedState.waitingForAnotherActionKey = false;

        return false;
      case KeypressState.WaitingOnKeys:
        this.vimState.recordedState.waitingForAnotherActionKey = true;

        return false;
    }

    if (
      !this.remapState.remapUsedACharacter &&
      this.remapState.isCurrentlyPerformingRecursiveRemapping
    ) {
      // Used a character inside a recursive remapping so we reset the mapDepth.
      this.remapState.remapUsedACharacter = true;
      this.remapState.mapDepth = 0;
    }

    // Since we got an action we are no longer waiting any action keys
    this.vimState.recordedState.waitingForAnotherActionKey = false;

    // Store action pressed keys for showCmd
    recordedState.actionsRunPressedKeys.push(...recordedState.actionKeys);

    let actionToRecord: BaseAction | undefined = action;
    if (recordedState.actionsRun.length === 0) {
      recordedState.actionsRun.push(action);
    } else {
      const lastAction = recordedState.actionsRun[recordedState.actionsRun.length - 1];

      if (lastAction instanceof DocumentContentChangeAction) {
        if (!(action instanceof CommandEscInsertMode)) {
          // TODO: this includes things like <BS>, which it shouldn't
          lastAction.keysPressed.push(key);
        }

        if (
          action instanceof CommandInsertInInsertMode ||
          action instanceof CommandInsertPreviousText
        ) {
          // delay the macro recording
          actionToRecord = undefined;
        } else {
          // Push document content change to the stack
          lastAction.addChanges(this.vimState.historyTracker.currentContentChanges);
          this.vimState.historyTracker.currentContentChanges = [];
          recordedState.actionsRun.push(action);
        }
      } else {
        if (
          action instanceof CommandInsertInInsertMode ||
          action instanceof CommandInsertPreviousText
        ) {
          // This means we are already in Insert Mode but there is still not DocumentContentChangeAction in stack
          this.vimState.historyTracker.currentContentChanges = [];
          const newContentChange = new DocumentContentChangeAction();
          newContentChange.keysPressed.push(key);
          recordedState.actionsRun.push(newContentChange);
          actionToRecord = newContentChange;
        } else {
          recordedState.actionsRun.push(action);
        }
      }
    }

    if (
      this.vimState.macro !== undefined &&
      actionToRecord &&
      !(actionToRecord instanceof CommandQuitRecordMacro)
    ) {
      this.vimState.macro.actionsRun.push(actionToRecord);
    }

    await this.runAction(recordedState, action);

    if (this.vimState.currentMode === Mode.Insert) {
      recordedState.isInsertion = true;
    }

    // Update view
    await this.updateView();

    if (action.isJump) {
      globalState.jumpTracker.recordJump(
        Jump.fromStateBefore(this.vimState),
        Jump.fromStateNow(this.vimState)
      );
    }

    return true;
  }

  private async runAction(recordedState: RecordedState, action: IBaseAction): Promise<void> {
    let ranRepeatableAction = false;
    let ranAction = false;
    this.vimState.selectionsChanged.ignoreIntermediateSelections = true;

    // If arrow keys or mouse was used prior to entering characters while in insert mode, create an undo point
    // this needs to happen before any changes are made

    /*

    TODO: This causes . to crash vscodevim for some reason.

    if (!this.vimState.isMultiCursor) {
      let prevPos = this.vimState.historyTracker.getLastHistoryEndPosition();
      if (prevPos !== undefined && !this.vimState.isRunningDotCommand) {
        if (this.vimState.cursorPositionJustBeforeAnythingHappened[0].line !== prevPos[0].line ||
          this.vimState.cursorPositionJustBeforeAnythingHappened[0].character !== prevPos[0].character) {
          globalState.previousFullAction = recordedState;
          this.vimState.historyTracker.finishCurrentStep();
        }
      }
    }
    */

    // We handle the end of selections different to VSCode. In order for VSCode to select
    // including the last character we will at the end of 'runAction' shift our stop position
    // to the right. So here we shift it back by one so that our actions have our correct
    // position instead of the position sent to VSCode.
    if (this.vimState.currentMode === Mode.Visual) {
      this.vimState.cursors = this.vimState.cursors.map((c) =>
        c.start.isBefore(c.stop) ? c.withNewStop(c.stop.getLeftThroughLineBreaks(true)) : c
      );
    }

    // Make sure all cursors are within the document's bounds before running any action
    // It's not 100% clear to me that this is the correct place to do this, but it should solve a lot of issues
    this.vimState.cursors = this.vimState.cursors.map(
      (c) =>
        new Range(
          this.vimState.document.validatePosition(c.start),
          this.vimState.document.validatePosition(c.stop)
        )
    );

    if (action instanceof BaseMovement) {
      recordedState = await this.executeMovement(action);
      ranAction = true;
    }

    if (action instanceof BaseCommand) {
      await action.execCount(this.vimState.cursorStopPosition, this.vimState);

      const transformer = this.vimState.recordedState.transformer;
      await executeTransformations(this, transformer.transformations);

      if (action.isCompleteAction) {
        ranAction = true;
      }

      if (action.canBeRepeatedWithDot) {
        ranRepeatableAction = true;
      }
    }

    if (action instanceof BaseOperator) {
      recordedState.operatorCount = recordedState.count;
    }

    // Update mode (note the ordering allows you to go into search mode,
    // then return and have the motion immediately applied to an operator).
    const prevMode = this.currentMode;
    if (this.vimState.currentMode !== this.currentMode) {
      await this.setCurrentMode(this.vimState.currentMode);

      // We don't want to mark any searches as a repeatable action
      if (
        this.vimState.currentMode === Mode.Normal &&
        prevMode !== Mode.SearchInProgressMode &&
        prevMode !== Mode.CommandlineInProgress &&
        prevMode !== Mode.EasyMotionInputMode &&
        prevMode !== Mode.EasyMotionMode
      ) {
        ranRepeatableAction = true;
      }
    }

    if (recordedState.operatorReadyToExecute(this.vimState.currentMode)) {
      const operator = this.vimState.recordedState.operator;
      if (operator) {
        await this.executeOperator();
        this.vimState.recordedState.hasRunOperator = true;
        ranRepeatableAction = operator.canBeRepeatedWithDot;
        ranAction = true;
      }
    }

    // And then we have to do it again because an operator could
    // have changed it as well. (TODO: do you even decomposition bro)
    if (this.vimState.currentMode !== this.currentMode) {
      await this.setCurrentMode(this.vimState.currentMode);

      if (this.vimState.currentMode === Mode.Normal) {
        ranRepeatableAction = true;
      }
    }

    ranRepeatableAction =
      (ranRepeatableAction && this.vimState.currentMode === Mode.Normal) ||
      this.createUndoPointForBrackets();
    ranAction = ranAction && this.vimState.currentMode === Mode.Normal;

    // Record down previous action and flush temporary state
    if (ranRepeatableAction) {
      globalState.previousFullAction = this.vimState.recordedState;

      if (recordedState.isInsertion) {
        Register.setReadonlyRegister('.', recordedState);
      }
    }

    // Update desiredColumn
    if (!action.preservesDesiredColumn()) {
      if (action instanceof BaseMovement) {
        // We check !operator here because e.g. d$ should NOT set the desired column to EOL.
        if (action.setsDesiredColumnToEOL && !recordedState.operator) {
          this.vimState.desiredColumn = Number.POSITIVE_INFINITY;
        } else {
          this.vimState.desiredColumn = this.vimState.cursorStopPosition.character;
        }
      } else if (this.vimState.currentMode !== Mode.VisualBlock) {
        // TODO: explain why not VisualBlock
        this.vimState.desiredColumn = this.vimState.cursorStopPosition.character;
      }
    }

    // Like previously stated we handle the end of selections different to VSCode. In order
    // for VSCode to select including the last character we shift our stop position to the
    // right now that all steps that need that position have already run. On the next action
    // we will shift it back again on the start of 'runAction'.
    if (this.vimState.currentMode === Mode.Visual) {
      this.vimState.cursors = this.vimState.cursors.map((c) =>
        c.start.isBeforeOrEqual(c.stop)
          ? c.withNewStop(
              c.stop.isLineEnd() ? c.stop.getRightThroughLineBreaks() : c.stop.getRight()
            )
          : c
      );
    }

    if (ranAction) {
      this.vimState.recordedState = new RecordedState();

      // Return to insert mode after 1 command in this case for <C-o>
      if (this.vimState.returnToInsertAfterCommand) {
        if (this.vimState.actionCount > 0) {
          await this.setCurrentMode(Mode.Insert);
        } else {
          this.vimState.actionCount++;
        }
      }
    }

    // track undo history
    if (!this.vimState.focusChanged) {
      // important to ensure that focus didn't change, otherwise
      // we'll grab the text of the incorrect active window and assume the
      // whole document changed!

      if (this.vimState.alteredHistory) {
        this.vimState.alteredHistory = false;
        this.vimState.historyTracker.ignoreChange();
      } else {
        this.vimState.historyTracker.addChange(
          this.vimState.cursorsInitialState.map((c) => c.stop)
        );
      }
    }

    // Don't record an undo point for every action of a macro, only at the very end
    if (
      ranRepeatableAction &&
      !this.vimState.isReplayingMacro &&
      !this.remapState.isCurrentlyPerformingRemapping
    ) {
      this.vimState.historyTracker.finishCurrentStep();
    }

    recordedState.actionKeys = [];
    this.vimState.currentRegisterMode = RegisterMode.AscertainFromCurrentMode;

    if (this.currentMode === Mode.Normal) {
      this.vimState.cursors = this.vimState.cursors.map(
        (cursor) => new Range(cursor.stop, cursor.stop)
      );
    }

    // Ensure cursors are within bounds
    if (
      !this.vimState.document.isClosed &&
      this.vimState.editor === vscode.window.activeTextEditor
    ) {
      this.vimState.cursors = this.vimState.cursors.map((cursor: Range) => {
        // adjust start/stop
        const documentEndPosition = TextEditor.getDocumentEnd(this.vimState.document);
        const documentLineCount = this.vimState.document.lineCount;
        if (cursor.start.line >= documentLineCount) {
          cursor = cursor.withNewStart(documentEndPosition);
        }
        if (cursor.stop.line >= documentLineCount) {
          cursor = cursor.withNewStop(documentEndPosition);
        }

        // adjust column
        if (this.vimState.currentMode === Mode.Normal || isVisualMode(this.vimState.currentMode)) {
          const currentLineLength = TextEditor.getLineLength(cursor.stop.line);
          const currentStartLineLength = TextEditor.getLineLength(cursor.start.line);

          // When in visual mode you can move the cursor past the last character in order
          // to select that character. We use this offset to allow for that, otherwise
          // we would consider the position invalid and change it to the left of the last
          // character.
          const offsetAllowed =
            isVisualMode(this.vimState.currentMode) && currentLineLength > 0 ? 1 : 0;
          if (cursor.start.character >= currentStartLineLength) {
            cursor = cursor.withNewStart(
              cursor.start.withColumn(Math.max(currentStartLineLength - 1, 0))
            );
          }

          if (cursor.stop.character >= currentLineLength + offsetAllowed) {
            cursor = cursor.withNewStop(cursor.stop.withColumn(Math.max(currentLineLength - 1, 0)));
          }
        }
        return cursor;
      });
    }

    if (isVisualMode(this.vimState.currentMode) && !this.vimState.isRunningDotCommand) {
      // Store selection for commands like gv
      this.vimState.lastVisualSelection = {
        mode: this.vimState.currentMode,
        start: this.vimState.cursorStartPosition,
        end: this.vimState.cursorStopPosition,
      };
    }

    this.vimState.selectionsChanged.ignoreIntermediateSelections = false;
  }

  private async executeMovement(movement: BaseMovement): Promise<RecordedState> {
    this.vimState.lastMovementFailed = false;
    const recordedState = this.vimState.recordedState;
    const cursorsToRemove: number[] = [];

    for (let i = 0; i < this.vimState.cursors.length; i++) {
      /**
       * Essentially what we're doing here is pretending like the
       * current VimState only has one cursor (the cursor that we just
       * iterated to).
       *
       * We set the cursor position to be equal to the iterated one,
       * and then set it back immediately after we're done.
       *
       * The slightly more complicated logic here allows us to write
       * Action definitions without having to think about multiple
       * cursors in almost all cases.
       */
      const oldCursorPositionStart = this.vimState.cursorStartPosition;
      const oldCursorPositionStop = this.vimState.cursorStopPosition;
      movement.multicursorIndex = i;

      this.vimState.cursorStartPosition = this.vimState.cursors[i].start;
      const cursorPosition = this.vimState.cursors[i].stop;
      this.vimState.cursorStopPosition = cursorPosition;

      const result = await movement.execActionWithCount(
        cursorPosition,
        this.vimState,
        recordedState.count
      );

      // We also need to update the specific cursor, in case the cursor position was modified inside
      // the handling functions (e.g. 'it')
      this.vimState.cursors[i] = new Range(
        this.vimState.cursorStartPosition,
        this.vimState.cursorStopPosition
      );

      this.vimState.cursorStartPosition = oldCursorPositionStart;
      this.vimState.cursorStopPosition = oldCursorPositionStop;

      if (result instanceof Position) {
        this.vimState.cursors[i] = this.vimState.cursors[i].withNewStop(result);

        if (!isVisualMode(this.currentMode) && !this.vimState.recordedState.operator) {
          this.vimState.cursors[i] = this.vimState.cursors[i].withNewStart(result);
        }
      } else {
        if (result.failed) {
          this.vimState.recordedState = new RecordedState();
          this.vimState.lastMovementFailed = true;
        }

        if (result.removed) {
          cursorsToRemove.push(i);
        } else {
          this.vimState.cursors[i] = new Range(result.start, result.stop);
        }

        if (result.registerMode) {
          this.vimState.currentRegisterMode = result.registerMode;
        }
      }
    }

    if (cursorsToRemove.length > 0) {
      // Remove the cursors that no longer exist. Remove from the end to the start
      // so that the index values don't change.
      for (let i = cursorsToRemove.length - 1; i >= 0; i--) {
        const idx = cursorsToRemove[i];
        if (idx !== 0) {
          // We should never remove the main selection! This shouldn't happen, but just
          // in case it does, lets protect against it. Remember kids, always use protection!
          this.vimState.cursors.splice(idx, 1);
        }
      }
    }

    this.vimState.recordedState.count = 0;

    // Keep the cursor within bounds
    if (this.vimState.currentMode !== Mode.Normal || recordedState.operator) {
      const stop = this.vimState.cursorStopPosition;

      // Vim does this weird thing where it allows you to select and delete
      // the newline character, which it places 1 past the last character
      // in the line. This is why we use > instead of >=.

      if (stop.character > TextEditor.getLineLength(stop.line)) {
        this.vimState.cursorStopPosition = stop.getLineEnd();
      }
    }

    return recordedState;
  }

  private async executeOperator(): Promise<void> {
    const recordedState = this.vimState.recordedState;
    const operator = recordedState.operator!;

    // TODO - if actions were more pure, this would be unnecessary.
    const startingMode = this.vimState.currentMode;
    const startingRegisterMode = this.vimState.currentRegisterMode;

    const resultingCursors: Range[] = [];
    for (let [i, { start, stop }] of this.vimState.cursors.entries()) {
      operator.multicursorIndex = i;

      if (start.isAfter(stop)) {
        [start, stop] = [stop, start];
      }

      if (!isVisualMode(startingMode) && startingRegisterMode !== RegisterMode.LineWise) {
        stop = stop.getLeftThroughLineBreaks(true);
      }

      if (this.currentMode === Mode.VisualLine) {
        start = start.getLineBegin();
        stop = stop.getLineEnd();

        this.vimState.currentRegisterMode = RegisterMode.LineWise;
      }

      await this.vimState.setCurrentMode(startingMode);

      // We run the repeat version of an operator if the last 2 operators are the same.
      if (
        recordedState.operators.length > 1 &&
        recordedState.operators.reverse()[0].constructor ===
          recordedState.operators.reverse()[1].constructor
      ) {
        await operator.runRepeat(this.vimState, start, recordedState.count);
      } else {
        await operator.run(this.vimState, start, stop);
      }

      for (const transformation of this.vimState.recordedState.transformer.transformations) {
        if (isTextTransformation(transformation) && transformation.cursorIndex === undefined) {
          transformation.cursorIndex = operator.multicursorIndex;
        }
      }

      const resultingRange = new Range(
        this.vimState.cursorStartPosition,
        this.vimState.cursorStopPosition
      );

      resultingCursors.push(resultingRange);
    }

    if (this.vimState.recordedState.transformer.transformations.length > 0) {
      const transformer = this.vimState.recordedState.transformer;
      await executeTransformations(this, transformer.transformations);
    } else {
      // Keep track of all cursors (in the case of multi-cursor).
      this.vimState.cursors = resultingCursors;
    }
  }

  public async rerunRecordedState(recordedState: RecordedState): Promise<void> {
    const actions = [...recordedState.actionsRun];
    const { hasRunSurround, surroundKeys } = recordedState;

    this.vimState.isRunningDotCommand = true;

    // If a previous visual selection exists, store it for use in replay of some commands
    if (this.vimState.lastVisualSelection) {
      this.vimState.dotCommandPreviousVisualSelection = new vscode.Selection(
        this.vimState.lastVisualSelection.start,
        this.vimState.lastVisualSelection.end
      );
    }

    recordedState = new RecordedState();
    this.vimState.recordedState = recordedState;

    // Replay surround if applicable, otherwise rerun actions
    if (hasRunSurround) {
      await this.handleMultipleKeyEvents(surroundKeys);
    } else {
      for (const [i, action] of actions.entries()) {
        recordedState.actionsRun = actions.slice(0, i + 1);
        await this.runAction(recordedState, action);

        if (this.vimState.lastMovementFailed) {
          return;
        }

        await this.updateView();
      }
      recordedState.actionsRun = actions;
    }
    this.vimState.isRunningDotCommand = false;
  }

  public async runMacro(recordedMacro: RecordedState): Promise<void> {
    let recordedState = new RecordedState();
    this.vimState.recordedState = recordedState;
    this.vimState.isRunningDotCommand = true;

    for (const action of recordedMacro.actionsRun) {
      const originalLocation = Jump.fromStateNow(this.vimState);

      this.vimState.cursorsInitialState = this.vimState.cursors;

      recordedState.actionsRun.push(action);
      this.vimState.keyHistory = this.vimState.keyHistory.concat(action.keysPressed);

      await this.runAction(recordedState, action);

      // We just finished a full action; let's clear out our current state.
      if (this.vimState.recordedState.actionsRun.length === 0) {
        recordedState = new RecordedState();
        this.vimState.recordedState = recordedState;
      }

      if (this.vimState.lastMovementFailed) {
        break;
      }

      await this.updateView();

      if (action.isJump) {
        globalState.jumpTracker.recordJump(originalLocation, Jump.fromStateNow(this.vimState));
      }
    }

    this.vimState.isRunningDotCommand = false;
    this.vimState.cursorsInitialState = this.vimState.cursors;
  }

  public updateSearchHighlights(showHighlights: boolean) {
    let searchRanges: vscode.Range[] = [];
    if (showHighlights) {
      searchRanges = globalState.searchState?.getMatchRanges(this.vimState.editor) ?? [];
    }
    this.vimState.editor.setDecorations(decoration.searchHighlight, searchRanges);
  }

  public async updateView(
    args: { drawSelection: boolean; revealRange: boolean } = {
      drawSelection: true,
      revealRange: true,
    }
  ): Promise<void> {
    // Draw selection (or cursor)

    if (
      args.drawSelection &&
      !this.vimState.recordedState.actionsRun.some(
        (action) => action instanceof DocumentContentChangeAction
      )
    ) {
      let selectionMode: Mode = this.vimState.currentMode;
      if (this.vimState.currentMode === Mode.SearchInProgressMode) {
        selectionMode = globalState.searchState!.previousMode;
      } else if (this.vimState.currentMode === Mode.CommandlineInProgress) {
        selectionMode = commandLine.previousMode;
      } else if (this.vimState.currentMode === Mode.SurroundInputMode) {
        selectionMode = this.vimState.surround!.previousMode;
      }

      let selections = [] as vscode.Selection[];
      for (const cursor of this.vimState.cursors) {
        let { start, stop } = cursor;
        switch (selectionMode) {
          case Mode.Visual:
            /**
             * Always select the letter that we started visual mode on, no matter
             * if we are in front or behind it. Imagine that we started visual mode
             * with some text like this:
             *
             *   abc|def
             *
             * (The | represents the cursor.) If we now press w, we'll select def,
             * but if we hit b we expect to select abcd, so we need to getRight() on the
             * start of the selection when it precedes where we started visual mode.
             */
            if (start.isAfterOrEqual(stop)) {
              start = start.getRight();
            }

            selections.push(new vscode.Selection(start, stop));
            break;

          case Mode.VisualLine:
            if (start.isBeforeOrEqual(stop)) {
              selections.push(new vscode.Selection(start.getLineBegin(), stop.getLineEnd()));
            } else {
              selections.push(new vscode.Selection(start.getLineEnd(), stop.getLineBegin()));
            }
            break;

          case Mode.VisualBlock:
            for (const line of TextEditor.iterateLinesInBlock(this.vimState, cursor)) {
              selections.push(new vscode.Selection(line.start, line.end));
            }
            break;

          default:
            // Note that this collapses the selection onto one position
            selections.push(new vscode.Selection(stop, stop));
            break;
        }
      }

      /**
       * Combine instersected selections - When we have multiple cursors
       * sometimes those cursors selections intersect and combine, we need
       * to check that here so that we know if our currents cursors will
       * trigger a selectionChangeEvent or not. If we didn't check for this
       * vscode might already have the resulting combined selection selected
       * but since that wouldn't be the same as our selections we would think
       * there would be a selectionChangeEvent when there wouldn't be any.
       */
      const getSelectionsCombined = (sel: vscode.Selection[]) => {
        const combinedSelections: vscode.Selection[] = [];
        sel.forEach((s, i) => {
          if (i > 0) {
            const previousSelection = combinedSelections[combinedSelections.length - 1];
            const overlap = s.intersection(previousSelection);
            if (overlap) {
              // If anchor is after active we have a backwards selection and in that case we want
              // the anchor that is lower and/or to the right and the active that is up and/or to
              // the left. Otherwise we want the anchor that is upper and/or to the left and the
              // active that is lower and/or to the right.

              let anchor: Position;
              let active: Position;
              if (s.anchor.isBeforeOrEqual(s.active)) {
                // Forwards Selection

                // Get min anchor
                if (s.anchor.isBeforeOrEqual(previousSelection.anchor)) {
                  anchor = s.anchor;
                } else {
                  anchor = previousSelection.anchor;
                }

                // Get max active
                if (s.active.isAfterOrEqual(previousSelection.active)) {
                  active = s.active;
                } else {
                  active = previousSelection.active;
                }
              } else {
                // Backwards Selection

                // Get max anchor
                if (s.anchor.isAfterOrEqual(previousSelection.anchor)) {
                  anchor = s.anchor;
                } else {
                  anchor = previousSelection.anchor;
                }

                // Get min active
                if (s.active.isBeforeOrEqual(previousSelection.active)) {
                  active = s.active;
                } else {
                  active = previousSelection.active;
                }
              }
              combinedSelections[combinedSelections.length - 1] = new vscode.Selection(
                anchor,
                active
              );
            } else {
              combinedSelections.push(s);
            }
          } else {
            combinedSelections.push(s);
          }
        });
        return combinedSelections;
      };
      selections = getSelectionsCombined(selections);

      // Check if the selection we are going to set is different than the current one.
      // If they are the same vscode won't trigger a selectionChangeEvent so we don't
      // have to add it to the ignore selections.
      const willTriggerChange =
        selections.length !== this.vimState.editor.selections.length ||
        selections.some(
          (s, i) =>
            !s.anchor.isEqual(this.vimState.editor.selections[i].anchor) ||
            !s.active.isEqual(this.vimState.editor.selections[i].active)
        );

      if (willTriggerChange) {
        const selectionsHash = selections.reduce(
          (hash, s) =>
            hash +
            `[${s.anchor.line}, ${s.anchor.character}; ${s.active.line}, ${s.active.character}]`,
          ''
        );
        this.vimState.selectionsChanged.ourSelections.push(selectionsHash);
        ModeHandler.logger.debug(
          `Selections: Adding Selection Change to be Ignored! Hash: ${selectionsHash}, Selections: ${selections[0].anchor.toString()}, ${selections[0].active.toString()}`
        );
      }

      this.vimState.editor.selections = selections;
    }

    // Scroll to position of cursor
    if (
      this.vimState.editor.visibleRanges.length > 0 &&
      !this.vimState.postponedCodeViewChanges.some((change) => change.command === 'editorScroll')
    ) {
      /**
       * This variable decides to which cursor we scroll the view.
       * It is meant as a patch to #880.
       * Extend this condition if it is the desired behaviour for other actions as well.
       */
      const isLastCursorTracked =
        this.vimState.recordedState.getLastActionRun() instanceof ActionOverrideCmdD;

      let cursorToTrack: Range;
      if (isLastCursorTracked) {
        cursorToTrack = this.vimState.cursors[this.vimState.cursors.length - 1];
      } else {
        cursorToTrack = this.vimState.cursors[0];
      }

      const isCursorAboveRange = (visibleRange: vscode.Range): boolean =>
        visibleRange.start.line - cursorToTrack.stop.line >= 15;
      const isCursorBelowRange = (visibleRange: vscode.Range): boolean =>
        cursorToTrack.stop.line - visibleRange.end.line >= 15;

      const { visibleRanges } = this.vimState.editor;
      const centerViewportAroundCursor =
        visibleRanges.every(isCursorAboveRange) || visibleRanges.every(isCursorBelowRange);

      const revealType = centerViewportAroundCursor
        ? vscode.TextEditorRevealType.InCenter
        : vscode.TextEditorRevealType.Default;

      if (
        this.vimState.currentMode === Mode.SearchInProgressMode &&
        globalState.searchState &&
        configuration.incsearch
      ) {
        const nextMatch = globalState.searchState.getNextSearchMatchPosition(
          this.vimState.editor,
          this.vimState.cursorStopPosition
        );

        if (nextMatch?.match) {
          this.vimState.editor.revealRange(
            new vscode.Range(nextMatch.pos, nextMatch.pos),
            revealType
          );
        } else if (this.vimState.firstVisibleLineBeforeSearch !== undefined) {
          const offset =
            this.vimState.editor.visibleRanges[0].start.line -
            this.vimState.firstVisibleLineBeforeSearch;
          scrollView(this.vimState, offset);
        }
      } else if (args.revealRange) {
        if (
          !isLastCursorTracked ||
          this.vimState.cursorsInitialState.length !== this.vimState.cursors.length
        ) {
          /**
           * We scroll the view if either:
           * 1. the cursor we want to keep in view is the main one (this is the "standard"
           * (before this commit) situation)
           * 2. if we track the last cursor, but no additional cursor was created in this step
           * (in the Cmd+D situation this means that no other matches were found)
           */
          this.vimState.editor.revealRange(
            new vscode.Range(cursorToTrack.stop, cursorToTrack.stop),
            revealType
          );
        }
      }
    }

    // cursor style
    let cursorStyle = configuration.getCursorStyleForMode(Mode[this.currentMode]);
    if (!cursorStyle) {
      const cursorType = getCursorType(
        this.vimState,
        this.vimState.currentModeIncludingPseudoModes
      );
      cursorStyle = getCursorStyle(cursorType);
      if (
        cursorType === VSCodeVimCursorType.Native &&
        configuration.editorCursorStyle !== undefined
      ) {
        cursorStyle = configuration.editorCursorStyle;
      }
    }
    this.vimState.editor.options.cursorStyle = cursorStyle;

    // cursor block
    const cursorRange: vscode.Range[] = [];
    if (
      getCursorType(this.vimState, this.currentMode) === VSCodeVimCursorType.TextDecoration &&
      this.currentMode !== Mode.Insert
    ) {
      // Fake block cursor with text decoration. Unfortunately we can't have a cursor
      // in the middle of a selection natively, which is what we need for Visual Mode.
      if (this.currentMode === Mode.Visual) {
        for (const { start: cursorStart, stop: cursorStop } of this.vimState.cursors) {
          if (cursorStart.isBefore(cursorStop)) {
            cursorRange.push(new vscode.Range(cursorStop.getLeft(), cursorStop));
          } else {
            cursorRange.push(new vscode.Range(cursorStop, cursorStop.getRight()));
          }
        }
      } else {
        for (const { stop: cursorStop } of this.vimState.cursors) {
          cursorRange.push(new vscode.Range(cursorStop, cursorStop.getRight()));
        }
      }
    }

    this.vimState.editor.setDecorations(decoration.default, cursorRange);

    // Insert Mode virtual characters: used to temporarily show the remapping pressed keys on
    // insert mode, to show the `"` character after pressing `<C-r>`, and to show `?` and the
    // first character when inserting digraphs with `<C-k>`.
    const iModeVirtualCharDecorationOptions: vscode.DecorationOptions[] = [];
    if (this.vimState.currentMode === Mode.Insert || this.vimState.currentMode === Mode.Replace) {
      let virtualKey: string | undefined;
      if (this.vimState.recordedState.bufferedKeys.length > 0) {
        virtualKey =
          this.vimState.recordedState.bufferedKeys[
            this.vimState.recordedState.bufferedKeys.length - 1
          ];
      } else if (this.vimState.recordedState.waitingForAnotherActionKey) {
        virtualKey =
          this.vimState.recordedState.actionKeys[this.vimState.recordedState.actionKeys.length - 1];
        if (virtualKey === '<C-r>') {
          virtualKey = '"';
        } else if (virtualKey === '<C-k>') {
          virtualKey = '?';
        }
      }
      // Don't show keys with `<` like `<C-x>` but show everything else
      virtualKey = virtualKey && /<[^>]+>/.test(virtualKey) ? undefined : virtualKey;

      if (virtualKey) {
        // Normal Render Options with the key to overlap on the next character
        const renderOptions: vscode.ThemableDecorationRenderOptions = {
          before: {
            contentText: virtualKey,
          },
        };

        /**
         * EOL Render Options:
         * Some times when at the end of line the `currentColor` won't work, or it might be
         * transparent, so we set the color to 'editor.foreground' when at EOL to avoid the
         * virtualKey character not showing up.
         */
        const eolRenderOptions: vscode.ThemableDecorationRenderOptions = {
          before: {
            contentText: virtualKey,
            color: new vscode.ThemeColor('editor.foreground'),
          },
        };

        for (const { stop: cursorStop } of this.vimState.cursors) {
          if (cursorStop.isLineEnd()) {
            iModeVirtualCharDecorationOptions.push({
              range: new vscode.Range(cursorStop, cursorStop.getLineEndIncludingEOL()),
              renderOptions: eolRenderOptions,
            });
          } else {
            iModeVirtualCharDecorationOptions.push({
              range: new vscode.Range(cursorStop, cursorStop.getRightThroughLineBreaks(true)),
              renderOptions,
            });
          }
        }
      }
    }

    this.vimState.editor.setDecorations(
      decoration.insertModeVirtualCharacter,
      iModeVirtualCharDecorationOptions
    );

    // OperatorPendingMode half block cursor
    const opCursorDecorations: vscode.DecorationOptions[] = [];
    const opCursorCharDecorations: vscode.DecorationOptions[] = [];
    if (this.vimState.currentModeIncludingPseudoModes === Mode.OperatorPendingMode) {
      for (const { stop: cursorStop } of this.vimState.cursors) {
        let text = TextEditor.getCharAt(this.vimState.document, cursorStop);
        // the ' ' (<space>) needs to be changed to '&nbsp;'
        text = text === ' ' ? '\u00a0' : text;
        const renderOptions: vscode.ThemableDecorationRenderOptions = {
          before: {
            contentText: text,
          },
        };
        opCursorDecorations.push({
          range: new vscode.Range(cursorStop, cursorStop.getRight()),
          renderOptions,
        });
        opCursorCharDecorations.push({
          range: new vscode.Range(cursorStop, cursorStop.getRight()),
          renderOptions,
        });
      }
    }

    this.vimState.editor.setDecorations(decoration.operatorPendingModeCursor, opCursorDecorations);
    this.vimState.editor.setDecorations(
      decoration.operatorPendingModeCursorChar,
      opCursorCharDecorations
    );

    for (const markDecoration of decoration.allMarkDecorations()) {
      this.vimState.editor.setDecorations(markDecoration, []);
    }

    if (configuration.showMarksInGutter) {
      for (const { position, name } of this.vimState.historyTracker.getMarks()) {
        const markDecoration = decoration.getOrCreateMarkDecoration(name);

        const markLine = position.getLineBegin();
        const markRange = new vscode.Range(markLine, markLine);

        this.vimState.editor.setDecorations(markDecoration, [markRange]);
      }
    }

    const showHighlights =
      (configuration.incsearch && this.currentMode === Mode.SearchInProgressMode) ||
      (configuration.hlsearch && globalState.hl);
    for (const editor of vscode.window.visibleTextEditors) {
      this.handlerMap
        .get(EditorIdentity.fromEditor(editor))
        ?.updateSearchHighlights(showHighlights);
    }

    const easyMotionDimRanges =
      this.currentMode === Mode.EasyMotionInputMode &&
      configuration.easymotionDimBackground &&
      this.vimState.easyMotion.searchAction instanceof SearchByNCharCommand
        ? [
            new vscode.Range(
              TextEditor.getDocumentBegin(),
              TextEditor.getDocumentEnd(this.vimState.document)
            ),
          ]
        : [];
    const easyMotionHighlightRanges =
      this.currentMode === Mode.EasyMotionInputMode &&
      this.vimState.easyMotion.searchAction instanceof SearchByNCharCommand
        ? this.vimState.easyMotion.searchAction
            .getMatches(this.vimState.cursorStopPosition, this.vimState)
            .map((match) => match.toRange())
        : [];
    this.vimState.editor.setDecorations(decoration.easyMotionDimIncSearch, easyMotionDimRanges);
    this.vimState.editor.setDecorations(decoration.easyMotionIncSearch, easyMotionHighlightRanges);

    for (const viewChange of this.vimState.postponedCodeViewChanges) {
      vscode.commands.executeCommand(viewChange.command, viewChange.args);
    }
    this.vimState.postponedCodeViewChanges = [];

    if (this.currentMode === Mode.EasyMotionMode) {
      // Update all EasyMotion decorations
      this.vimState.easyMotion.updateDecorations(this.vimState.editor);
    }

    StatusBar.clear(this.vimState, false);

    // NOTE: this is not being awaited to save the 15-20ms block - I think this is fine
    VSCodeContext.set('vim.mode', Mode[this.vimState.currentMode]);

    // Tell VSCode that the cursor position changed, so it updates its highlights for `editor.occurrencesHighlight`.
    const range = new vscode.Range(
      this.vimState.cursorStartPosition,
      this.vimState.cursorStopPosition
    );
    if (!/\s+/.test(this.vimState.document.getText(range))) {
      vscode.commands.executeCommand('editor.action.wordHighlight.trigger');
    }
  }

  // Return true if a new undo point should be created based on brackets and parentheses
  private createUndoPointForBrackets(): boolean {
    // }])> keys all start a new undo state when directly next to an {[(< opening character
    const key =
      this.vimState.recordedState.actionKeys[this.vimState.recordedState.actionKeys.length - 1];

    if (key === undefined) {
      return false;
    }

    if (this.vimState.currentMode === Mode.Insert) {
      // Check if the keypress is a closing bracket to a corresponding opening bracket right next to it
      let result = PairMatcher.nextPairedChar(
        this.vimState.cursorStopPosition,
        key,
        this.vimState,
        false
      );
      if (result !== undefined) {
        if (this.vimState.cursorStopPosition.isEqual(result)) {
          return true;
        }
      }

      result = PairMatcher.nextPairedChar(
        this.vimState.cursorStopPosition.getLeft(),
        key,
        this.vimState,
        false
      );
      if (result !== undefined) {
        if (this.vimState.cursorStopPosition.getLeft(2).isEqual(result)) {
          return true;
        }
      }
    }

    return false;
  }

  dispose() {
    this.disposables.map((d) => d.dispose());
  }
}

function getCursorType(vimState: VimState, mode: Mode): VSCodeVimCursorType {
  switch (mode) {
    case Mode.Normal:
      return VSCodeVimCursorType.Block;
    case Mode.Insert:
      return VSCodeVimCursorType.Native;
    case Mode.Visual:
      return VSCodeVimCursorType.TextDecoration;
    case Mode.VisualBlock:
      return VSCodeVimCursorType.TextDecoration;
    case Mode.VisualLine:
      return VSCodeVimCursorType.TextDecoration;
    case Mode.SearchInProgressMode:
      return VSCodeVimCursorType.UnderlineThin;
    case Mode.CommandlineInProgress:
      return VSCodeVimCursorType.UnderlineThin;
    case Mode.Replace:
      return VSCodeVimCursorType.Underline;
    case Mode.EasyMotionMode:
      return VSCodeVimCursorType.Block;
    case Mode.EasyMotionInputMode:
      return VSCodeVimCursorType.Block;
    case Mode.SurroundInputMode:
      return getCursorType(vimState, vimState.surround!.previousMode);
    case Mode.OperatorPendingMode:
      return VSCodeVimCursorType.UnderlineThin;
    case Mode.Disabled:
    default:
      return VSCodeVimCursorType.Line;
  }
}
