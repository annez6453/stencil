import * as d from '../../declarations';
import { dashToPascalCase } from '../../util/helpers';
import { gatherMetadata } from './datacollection/index';
import { getComponentsDtsTypesFilePath } from '../collections/distribution';
import { MEMBER_TYPE } from '../../util/constants';
import { normalizeAssetsDir } from '../component-plugins/assets-plugin';
import { normalizePath } from '../util';
import { normalizeStyles } from '../style/normalize-styles';
import * as ts from 'typescript';


export async function generateComponentTypes(config: d.Config, compilerCtx: d.CompilerCtx, buildCtx: d.BuildCtx, tsOptions: ts.CompilerOptions, tsHost: ts.CompilerHost, tsFilePaths: string[], componentsDtsSrcFilePath: string) {
  // get all of the ts files paths to transpile
  // ensure the components.d.ts file is always excluded from this transpile program
  const checkProgramTsFiles = tsFilePaths.filter(filePath => filePath !== componentsDtsSrcFilePath);

  // keep track of how many files we transpiled (great for debugging/testing)
  buildCtx.transpileBuildCount = checkProgramTsFiles.length;

  // run the first program that only does the checking
  const checkProgram = ts.createProgram(checkProgramTsFiles, tsOptions, tsHost);

  // Gather component metadata and type info
  const metadata = gatherMetadata(config, compilerCtx, buildCtx, checkProgram.getTypeChecker(), checkProgram.getSourceFiles());

  Object.keys(metadata).forEach(key => {
    const tsFilePath = normalizePath(key);
    const fileMetadata = metadata[tsFilePath];
    // normalize metadata
    fileMetadata.stylesMeta = normalizeStyles(config, tsFilePath, fileMetadata.stylesMeta);
    fileMetadata.assetsDirsMeta = normalizeAssetsDir(config, tsFilePath, fileMetadata.assetsDirsMeta);

    // assign metadata to module files
    if (!compilerCtx.moduleFiles[tsFilePath]) {
      compilerCtx.moduleFiles[tsFilePath] = {};
    }
    compilerCtx.moduleFiles[tsFilePath].cmpMeta = fileMetadata;
  });

  // Generate d.ts files for component types
  const componentTypesFileContent = await generateComponentTypesFile(config, compilerCtx, metadata);

  // queue the components.d.ts async file write and put it into memory
  await compilerCtx.fs.writeFile(componentsDtsSrcFilePath, componentTypesFileContent);

  const typesOutputTargets = (config.outputTargets as d.OutputTargetDist[]).filter(o => !!o.typesDir);

  await Promise.all(typesOutputTargets.map(async outputTarget => {
    const typesFile = getComponentsDtsTypesFilePath(config, outputTarget);
    await compilerCtx.fs.writeFile(typesFile, componentTypesFileContent);
  }));

  return checkProgram;
}


/**
 * Generate the component.d.ts file that contains types for all components
 * @param config the project build configuration
 * @param options compiler options from tsconfig
 */
export async function generateComponentTypesFile(config: d.Config, compilerCtx: d.CompilerCtx, cmpList: d.ComponentRegistry) {
  let typeImportData: ImportData = {};
  const allTypes: { [key: string]: number } = {};
  let componentsFileContent =
`/**
 * This is an autogenerated file created by the Stencil build process.
 * It contains typing information for all components that exist in this project
 * and imports for stencil collections that might be configured in your stencil.config.js file
 */
declare global {
  namespace JSX {
    interface Element {}
    export interface IntrinsicElements {}
  }
  namespace JSXElements {}

  interface HTMLStencilElement extends HTMLElement {
    componentOnReady(): Promise<this>;
    componentOnReady(done: (ele?: this) => void): void;

    forceUpdate(): void;
  }

  interface HTMLAttributes {}
}\n\n`;


  const collectionTypesImports = await getCollectionsTypeImports(config, compilerCtx);

  componentsFileContent += collectionTypesImports;

  const componentFileString = Object.keys(cmpList)
    .filter(moduleFileName => cmpList[moduleFileName] != null)
    .sort()
    .reduce((finalString, moduleFileName) => {
      const cmpMeta = cmpList[moduleFileName];
      const importPath = normalizePath(config.sys.path.relative(config.srcDir, moduleFileName)
          .replace(/\.(tsx|ts)$/, ''));

      typeImportData = updateReferenceTypeImports(config, typeImportData, allTypes, cmpMeta, moduleFileName);

      finalString +=
        `${createTypesAsString(cmpMeta, importPath)}\n`;

      return finalString;
    }, '');

  const typeImportString = Object.keys(typeImportData).reduce((finalString: string, filePath: string) => {

    const typeData = typeImportData[filePath];
    let importFilePath: string;
    if (config.sys.path.isAbsolute(filePath)) {
      importFilePath = normalizePath('./' +
        config.sys.path.relative(config.srcDir, filePath)
      ).replace(/\.(tsx|ts)$/, '');
    } else {
      importFilePath = filePath;
    }
    finalString +=
`import {
${typeData.sort(sortImportNames).map(td => {
  if (td.localName === td.importName) {
    return `  ${td.importName},`;
  } else {
    return `  ${td.localName} as ${td.importName},`;
  }
}).join('\n')}
} from '${importFilePath}';\n`;

    return finalString;
  }, '');

  componentsFileContent += typeImportString + componentFileString;

  if (componentFileString.includes('namespace JSX')) {
    componentsFileContent += `declare global { namespace JSX { interface StencilJSX {} } }\n`;
  }

  return componentsFileContent;
}


function sortImportNames(a: MemberNameData, b: MemberNameData) {
  const aName = a.localName.toLowerCase();
  const bName = b.localName.toLowerCase();

  if (aName < bName) return -1;
  if (aName > bName) return 1;
  if (a.localName < b.localName) return -1;
  if (a.localName > b.localName) return 1;
  return 0;
}


/**
 * Find all referenced types by a component and add them to the importDataObj and return the newly
 * updated importDataObj
 *
 * @param importDataObj key/value of type import file, each value is an array of imported types
 * @param cmpMeta the metadata for the component that is referencing the types
 * @param filePath the path of the component file
 * @param config general config that all of stencil uses
 */
function updateReferenceTypeImports(config: d.Config, importDataObj: ImportData, allTypes: { [key: string]: number }, cmpMeta: d.ComponentMeta, filePath: string) {

  function getIncrememntTypeName(name: string): string {
    if (allTypes[name] == null) {
      allTypes[name] = 1;
      return name;
    }

    allTypes[name] += 1;
    return `${name}${allTypes[name]}`;
  }

  return Object.keys(cmpMeta.membersMeta)
  .filter((memberName) => {
    const member: d.MemberMeta = cmpMeta.membersMeta[memberName];

    return METADATA_MEMBERS_TYPED.indexOf(member.memberType) !== -1 &&
      member.attribType.typeReferences;
  })
  .reduce((obj, memberName) => {
    const member: d.MemberMeta = cmpMeta.membersMeta[memberName];
    Object.keys(member.attribType.typeReferences).forEach(typeName => {
      const type = member.attribType.typeReferences[typeName];
      let importFileLocation: string;

      // If global then there is no import statement needed
      if (type.referenceLocation === 'global') {
        return;

      // If local then import location is the current file
      } else if (type.referenceLocation === 'local') {
        importFileLocation = filePath;

      } else if (type.referenceLocation === 'import') {
        importFileLocation = type.importReferenceLocation;
      }

      // If this is a relative path make it absolute
      if (importFileLocation.startsWith('.')) {
        importFileLocation =
          config.sys.path.resolve(
            config.sys.path.dirname(filePath),
            importFileLocation
          );
      }

      obj[importFileLocation] = obj[importFileLocation] || [];

      // If this file already has a reference to this type move on
      if (obj[importFileLocation].find(df => df.localName === typeName)) {
        return;
      }

      const newTypeName = getIncrememntTypeName(typeName);
      obj[importFileLocation].push({
        localName: typeName,
        importName: newTypeName
      });
    });

    return obj;
  }, importDataObj);
}


/**
 * Generate a string based on the types that are defined within a component.
 *
 * @param cmpMeta the metadata for the component that a type definition string is generated for
 * @param importPath the path of the component file
 */
export function createTypesAsString(cmpMeta: d.ComponentMeta, importPath: string) {
  const tagName = cmpMeta.tagNameMeta;
  const tagNameAsPascal = dashToPascalCase(cmpMeta.tagNameMeta);
  const interfaceName = `HTML${tagNameAsPascal}Element`;
  const jsxInterfaceName = `${tagNameAsPascal}Attributes`;
  const interfaceOptions = membersToInterfaceOptions(cmpMeta.membersMeta);

  return `
import {
  ${cmpMeta.componentClass} as ${dashToPascalCase(cmpMeta.tagNameMeta)}
} from './${importPath}';

declare global {
  interface ${interfaceName} extends ${tagNameAsPascal}, HTMLStencilElement {
  }
  var ${interfaceName}: {
    prototype: ${interfaceName};
    new (): ${interfaceName};
  };
  interface HTMLElementTagNameMap {
    "${tagName}": ${interfaceName};
  }
  interface ElementTagNameMap {
    "${tagName}": ${interfaceName};
  }
  namespace JSX {
    interface IntrinsicElements {
      "${tagName}": JSXElements.${jsxInterfaceName};
    }
  }
  namespace JSXElements {
    export interface ${jsxInterfaceName} extends HTMLAttributes {
      ${Object.keys(interfaceOptions)
        .sort(sortInterfaceMembers)
        .map((key: string) => `${key}?: ${interfaceOptions[key]};`).join('\n      ')}
    }
  }
}
`;
}


function sortInterfaceMembers(a: string, b: string) {
  const aLower = a.toLowerCase();
  const bLower = b.toLowerCase();

  if (aLower < bLower) return -1;
  if (aLower > bLower) return 1;
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}


function membersToInterfaceOptions(membersMeta: d.MembersMeta): { [key: string]: string } {
  const interfaceData = Object.keys(membersMeta)
    .filter((memberName) => {
      return METADATA_MEMBERS_TYPED.indexOf(membersMeta[memberName].memberType) !== -1;
    })
    .reduce((obj, memberName) => {
      const member: d.MemberMeta = membersMeta[memberName];
      obj[memberName] = member.attribType.text;

      return obj;
    }, <{ [key: string]: string }>{});

  return interfaceData;
}


async function getCollectionsTypeImports(config: d.Config, compilerCtx: d.CompilerCtx) {
  const collections = compilerCtx.collections.map(collection => {
    return getCollectionTypesImport(config, compilerCtx, collection);
  });

  const collectionTypes = await Promise.all(collections);

  if (collectionTypes.length > 0) {
    return `${collectionTypes.join('\n')}\n\n`;
  }

  return '';
}


async function getCollectionTypesImport(config: d.Config, compilerCtx: d.CompilerCtx, collection: d.Collection) {
  let typeImport = '';

  try {
    const collectionDir = collection.moduleDir;
    const collectionPkgJson = config.sys.path.join(collectionDir, 'package.json');

    const pkgJsonStr = await compilerCtx.fs.readFile(collectionPkgJson);
    const pkgData: d.PackageJsonData = JSON.parse(pkgJsonStr);

    if (pkgData.types && pkgData.collection) {
      typeImport = `import '${pkgData.name}';`;
    }

  } catch (e) {
    config.logger.debug(`getCollectionTypesImport: ${e}`);
  }

  if (typeImport === '') {
    config.logger.debug(`unabled to find "${collection.collectionName}" collection types`);
  }

  return typeImport;
}



const METADATA_MEMBERS_TYPED = [ MEMBER_TYPE.Prop, MEMBER_TYPE.PropMutable ];

export interface ImportData {
  [key: string]: MemberNameData[];
}

export interface MemberNameData {
  localName: string;
  importName?: string;
}
