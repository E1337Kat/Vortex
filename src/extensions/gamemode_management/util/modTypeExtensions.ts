import { IGame, IModType } from "../../../types/IGame";
import { IInstruction } from "../../../types/IExtensionContext";

import * as Promise from 'bluebird';

const modTypeExtensions: IModType[] = [];

export function getModTypeExtensions(): IModType[] {
  return modTypeExtensions;
}

export function registerModType(id: string, priority: number,
                                isSupported: (gameId: string) => boolean,
                                getPath: (game: IGame) => string,
                                test: (instructions: IInstruction[]) => Promise<boolean>,
                                interceptInstructions: (gameId: string, instructions: IInstruction[]) => IInstruction[]) {
  modTypeExtensions.push({
    typeId: id,
    priority,
    isSupported,
    getPath,
    test,
    interceptInstructions,
  });
}
