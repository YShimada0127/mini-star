import { getPluginList, getPluginUrlPrefix, loadPluginByUrl } from './loader';
import {
  createNewModuleLoader,
  processModulePath,
  setModuleLoaderLoaded,
} from './utils';

type Module = ministar.Module;
type ModuleLoader = ministar.ModuleLoader;

interface LoadedModuleMap {
  [key: string]: ModuleLoader;
}

const loadedModules: LoadedModuleMap = {};

if (process.env.NODE_ENV === 'development') {
  // For debug.
  (window as any).loadedModules = loadedModules;
}

function generateModuleName(scriptUrl: string): string {
  const pluginList = getPluginList();
  const searchedPlugin = Object.entries(pluginList).find(
    ([key, value]) => value.url === scriptUrl
  );
  if (searchedPlugin === undefined) {
    // Cannot find Plugin
    return scriptUrl;
  } else {
    return searchedPlugin[1].name;
  }
}

/**
 * Load Dependency Module
 */
async function loadDependency(dep: string): Promise<any> {
  const moduleName = generateModuleName(dep);

  if (dep.startsWith('@plugins/')) {
    // TODO: Its not good, change it!
    dep = dep.replace('@plugins/', getPluginUrlPrefix());
  }

  if (moduleName in loadedModules) {
    const pluginModule = loadedModules[moduleName];

    if (pluginModule.status === 'init') {
      pluginModule.status = 'loading';
      return new Promise((resolve, reject) => {
        pluginModule.resolves.push(resolve);

        if (typeof pluginModule.entryFn !== 'function') {
          reject('Load dependencies error, this should have a valid ');
          return;
        }

        pluginModule.entryFn();
      });
    } else if (
      pluginModule.status === 'loading' ||
      pluginModule.status === 'new'
    ) {
      return new Promise((resolve) => {
        pluginModule.resolves.push(resolve);
      });
    } else if (pluginModule.status === 'loaded') {
      return Promise.resolve(pluginModule.ins);
    }
  } else {
    loadedModules[moduleName] = createNewModuleLoader();

    if (!dep.endsWith('.js') && !dep.startsWith('./')) {
      console.error(
        `[${dep}] Looks like is builtin module, and its cannot load as remote script.`
      );
      return;
    }

    return new Promise((resolve, reject) => {
      loadPluginByUrl(dep)
        .then(() => {
          const pluginModule = loadedModules[moduleName];
          pluginModule.status = 'loading';

          if (typeof pluginModule.entryFn !== 'function') {
            pluginModule.resolves.push(resolve);
            setModuleLoaderLoaded(pluginModule, null);
            return;
          }
          pluginModule.resolves.push(resolve);
          pluginModule.entryFn();
        })
        .catch((err) => {
          reject(err);
        });
    });
  }
}

export function requirePlugin(
  deps: string[],
  callback: (...args: Module[]) => void
): void {
  console.log('requirePlugin', deps);
  const allPromises = Promise.all(
    deps
      .map((dep, index) => {
        return loadDependency(dep);
      })
      .filter(Boolean)
  );

  allPromises
    .then((args) => callback(...args))
    .catch((err) => {
      console.error(err);
      callback([]);
    });
}

export function definePlugin(
  name: string,
  deps: string[],
  callback: (...args: any[]) => Module
) {
  const moduleName = name;

  if (!loadedModules[moduleName]) {
    loadedModules[moduleName] = {
      resolves: [],
    } as any;
  }
  loadedModules[moduleName].status = 'init';
  loadedModules[moduleName].entryFn = () => {
    const convertedDeps = deps.map((module) => processModulePath(name, module));

    const requireIndex = deps.findIndex((x) => x === 'require');
    const exportsIndex = deps.findIndex((x) => x === 'exports');

    const requiredDeps = convertedDeps.filter(
      (x) => x !== 'require' && x !== 'exports'
    );

    requirePlugin(requiredDeps, (...callbackArgs) => {
      let exports: any = {};

      // Replace require
      if (requireIndex !== -1) {
        callbackArgs.splice(
          requireIndex,
          0,
          (deps: string[], callback: (...args: any[]) => void) => {
            const convertedDeps = deps.map((module) =>
              processModulePath(name, module)
            );
            requirePlugin(convertedDeps, callback);
          }
        );
      }

      // Replace exports
      if (exportsIndex !== -1) {
        callbackArgs.splice(exportsIndex, 0, exports);
      }

      try {
        const ret = callback(...callbackArgs);
        if (exportsIndex === -1 && ret) {
          exports = ret;
        }
      } catch (e) {
        console.error('Plugin init failed:', name, e);
        return Promise.reject(e);
      }

      setModuleLoaderLoaded(loadedModules[name], exports);
    });
  };
}
