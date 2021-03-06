import { EntryComponent, EntryPoint, ModuleFile } from '../../declarations';
import { processAppGraph } from './app-graph';


export function generateComponentEntries(
  allModules: ModuleFile[],
  userConfigEntryTags: string[][],
  appEntryTags: string[]
) {
  // user config entry modules you leave as is
  // whatever the user put in the bundle is how it goes
  const entryPoints: EntryPoint[] = [];

  const userConfigEntryPoints = processUserConfigBundles(userConfigEntryTags);
  entryPoints.push(...userConfigEntryPoints);

  // process all of the app's components not already found
  // in the config or the root html
  const appEntries = processAppComponentEntryTags(allModules, entryPoints, appEntryTags);
  entryPoints.push(...appEntries);

  return entryPoints;
}


export function processAppComponentEntryTags(allModules: ModuleFile[], entryPoints: EntryPoint[], appEntryTags: string[]) {
  // remove any tags already found in user config
  appEntryTags = appEntryTags.filter(tag => !entryPoints.some(ep => ep.some(em => em.tag === tag)));

  return processAppGraph(allModules, appEntryTags);
}


export function processUserConfigBundles(userConfigEntryTags: string[][]) {
  return userConfigEntryTags.map(entryTags => {
    return entryTags.map(entryTag => {
      const entryComponent: EntryComponent = {
        tag: entryTag,
        dependencyOf: ['#config']
      };
      return entryComponent;
    });
  });
}
