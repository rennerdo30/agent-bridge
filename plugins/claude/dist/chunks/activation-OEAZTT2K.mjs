import { createRequire as __abCreateRequire } from 'node:module'; const require = __abCreateRequire(import.meta.url);
import {
  MobileDesktopAdmin,
  MobileFault,
  MobileStore,
  digest,
  listRunsResponsive,
  protect,
  readDashboard,
  secret
} from "./chunk-WJ5ZHC7M.mjs";
import "./chunk-AJ3G2ZXC.mjs";
import "./chunk-KQJ5KQYW.mjs";
import "./chunk-HZAGME3J.mjs";
import "./chunk-3JP4MGBL.mjs";
import "./chunk-7DGC3ZS3.mjs";
import "./chunk-GNU2R6Z4.mjs";
import "./chunk-T2J55K7Z.mjs";
import "./chunk-6KTEQAZ2.mjs";
import "./chunk-2ITSHKVP.mjs";
import "./chunk-D5ZW6VFT.mjs";
import "./chunk-6QYUKHRG.mjs";
import "./chunk-JTZGNEMM.mjs";
import "./chunk-M26SH6VN.mjs";
import "./chunk-V4WDBMEN.mjs";
import "./chunk-7Z2VIXGN.mjs";
import {
  MobileActivationFault,
  privateAddress,
  readPrivateMaterial,
  windowsPrivateAcl
} from "./chunk-G7TNFXYS.mjs";
import "./chunk-4QXHCXBU.mjs";
import {
  QuestionVersionConflict,
  normalizeProject,
  ownerQuestionVersion
} from "./chunk-O5KYOVO2.mjs";
import {
  external_exports
} from "./chunk-EA6YAI7Y.mjs";
import "./chunk-UX2NNI32.mjs";
import "./chunk-A46UT6YH.mjs";
import "./chunk-WM3QOXKL.mjs";
import "./chunk-HYOPFLLN.mjs";
import "./chunk-PAJVYTSE.mjs";
import "./chunk-7EBNNXGO.mjs";
import "./chunk-EZXQJRQM.mjs";
import {
  __commonJS,
  __esm,
  __export,
  __toCommonJS,
  __toESM
} from "./chunk-6RNADTH4.mjs";

// node_modules/reflect-metadata/Reflect.js
var require_Reflect = __commonJS({
  "node_modules/reflect-metadata/Reflect.js"() {
    var Reflect2;
    (function(Reflect3) {
      (function(factory) {
        var root = typeof globalThis === "object" ? globalThis : typeof global === "object" ? global : typeof self === "object" ? self : typeof this === "object" ? this : sloppyModeThis();
        var exporter = makeExporter(Reflect3);
        if (typeof root.Reflect !== "undefined") {
          exporter = makeExporter(root.Reflect, exporter);
        }
        factory(exporter, root);
        if (typeof root.Reflect === "undefined") {
          root.Reflect = Reflect3;
        }
        function makeExporter(target, previous) {
          return function(key, value) {
            Object.defineProperty(target, key, { configurable: true, writable: true, value });
            if (previous)
              previous(key, value);
          };
        }
        function functionThis() {
          try {
            return Function("return this;")();
          } catch (_) {
          }
        }
        function indirectEvalThis() {
          try {
            return (void 0, eval)("(function() { return this; })()");
          } catch (_) {
          }
        }
        function sloppyModeThis() {
          return functionThis() || indirectEvalThis();
        }
      })(function(exporter, root) {
        var hasOwn = Object.prototype.hasOwnProperty;
        var supportsSymbol = typeof Symbol === "function";
        var toPrimitiveSymbol = supportsSymbol && typeof Symbol.toPrimitive !== "undefined" ? Symbol.toPrimitive : "@@toPrimitive";
        var iteratorSymbol = supportsSymbol && typeof Symbol.iterator !== "undefined" ? Symbol.iterator : "@@iterator";
        var supportsCreate = typeof Object.create === "function";
        var supportsProto = { __proto__: [] } instanceof Array;
        var downLevel = !supportsCreate && !supportsProto;
        var HashMap = {
          // create an object in dictionary mode (a.k.a. "slow" mode in v8)
          create: supportsCreate ? function() {
            return MakeDictionary(/* @__PURE__ */ Object.create(null));
          } : supportsProto ? function() {
            return MakeDictionary({ __proto__: null });
          } : function() {
            return MakeDictionary({});
          },
          has: downLevel ? function(map, key) {
            return hasOwn.call(map, key);
          } : function(map, key) {
            return key in map;
          },
          get: downLevel ? function(map, key) {
            return hasOwn.call(map, key) ? map[key] : void 0;
          } : function(map, key) {
            return map[key];
          }
        };
        var functionPrototype = Object.getPrototypeOf(Function);
        var _Map = typeof Map === "function" && typeof Map.prototype.entries === "function" ? Map : CreateMapPolyfill();
        var _Set = typeof Set === "function" && typeof Set.prototype.entries === "function" ? Set : CreateSetPolyfill();
        var _WeakMap = typeof WeakMap === "function" ? WeakMap : CreateWeakMapPolyfill();
        var registrySymbol = supportsSymbol ? /* @__PURE__ */ Symbol.for("@reflect-metadata:registry") : void 0;
        var metadataRegistry = GetOrCreateMetadataRegistry();
        var metadataProvider = CreateMetadataProvider(metadataRegistry);
        function decorate(decorators, target, propertyKey, attributes) {
          if (!IsUndefined(propertyKey)) {
            if (!IsArray(decorators))
              throw new TypeError();
            if (!IsObject(target))
              throw new TypeError();
            if (!IsObject(attributes) && !IsUndefined(attributes) && !IsNull(attributes))
              throw new TypeError();
            if (IsNull(attributes))
              attributes = void 0;
            propertyKey = ToPropertyKey(propertyKey);
            return DecorateProperty(decorators, target, propertyKey, attributes);
          } else {
            if (!IsArray(decorators))
              throw new TypeError();
            if (!IsConstructor(target))
              throw new TypeError();
            return DecorateConstructor(decorators, target);
          }
        }
        exporter("decorate", decorate);
        function metadata(metadataKey, metadataValue) {
          function decorator(target, propertyKey) {
            if (!IsObject(target))
              throw new TypeError();
            if (!IsUndefined(propertyKey) && !IsPropertyKey(propertyKey))
              throw new TypeError();
            OrdinaryDefineOwnMetadata(metadataKey, metadataValue, target, propertyKey);
          }
          return decorator;
        }
        exporter("metadata", metadata);
        function defineMetadata(metadataKey, metadataValue, target, propertyKey) {
          if (!IsObject(target))
            throw new TypeError();
          if (!IsUndefined(propertyKey))
            propertyKey = ToPropertyKey(propertyKey);
          return OrdinaryDefineOwnMetadata(metadataKey, metadataValue, target, propertyKey);
        }
        exporter("defineMetadata", defineMetadata);
        function hasMetadata(metadataKey, target, propertyKey) {
          if (!IsObject(target))
            throw new TypeError();
          if (!IsUndefined(propertyKey))
            propertyKey = ToPropertyKey(propertyKey);
          return OrdinaryHasMetadata(metadataKey, target, propertyKey);
        }
        exporter("hasMetadata", hasMetadata);
        function hasOwnMetadata(metadataKey, target, propertyKey) {
          if (!IsObject(target))
            throw new TypeError();
          if (!IsUndefined(propertyKey))
            propertyKey = ToPropertyKey(propertyKey);
          return OrdinaryHasOwnMetadata(metadataKey, target, propertyKey);
        }
        exporter("hasOwnMetadata", hasOwnMetadata);
        function getMetadata(metadataKey, target, propertyKey) {
          if (!IsObject(target))
            throw new TypeError();
          if (!IsUndefined(propertyKey))
            propertyKey = ToPropertyKey(propertyKey);
          return OrdinaryGetMetadata(metadataKey, target, propertyKey);
        }
        exporter("getMetadata", getMetadata);
        function getOwnMetadata(metadataKey, target, propertyKey) {
          if (!IsObject(target))
            throw new TypeError();
          if (!IsUndefined(propertyKey))
            propertyKey = ToPropertyKey(propertyKey);
          return OrdinaryGetOwnMetadata(metadataKey, target, propertyKey);
        }
        exporter("getOwnMetadata", getOwnMetadata);
        function getMetadataKeys(target, propertyKey) {
          if (!IsObject(target))
            throw new TypeError();
          if (!IsUndefined(propertyKey))
            propertyKey = ToPropertyKey(propertyKey);
          return OrdinaryMetadataKeys(target, propertyKey);
        }
        exporter("getMetadataKeys", getMetadataKeys);
        function getOwnMetadataKeys(target, propertyKey) {
          if (!IsObject(target))
            throw new TypeError();
          if (!IsUndefined(propertyKey))
            propertyKey = ToPropertyKey(propertyKey);
          return OrdinaryOwnMetadataKeys(target, propertyKey);
        }
        exporter("getOwnMetadataKeys", getOwnMetadataKeys);
        function deleteMetadata(metadataKey, target, propertyKey) {
          if (!IsObject(target))
            throw new TypeError();
          if (!IsUndefined(propertyKey))
            propertyKey = ToPropertyKey(propertyKey);
          if (!IsObject(target))
            throw new TypeError();
          if (!IsUndefined(propertyKey))
            propertyKey = ToPropertyKey(propertyKey);
          var provider = GetMetadataProvider(
            target,
            propertyKey,
            /*Create*/
            false
          );
          if (IsUndefined(provider))
            return false;
          return provider.OrdinaryDeleteMetadata(metadataKey, target, propertyKey);
        }
        exporter("deleteMetadata", deleteMetadata);
        function DecorateConstructor(decorators, target) {
          for (var i = decorators.length - 1; i >= 0; --i) {
            var decorator = decorators[i];
            var decorated = decorator(target);
            if (!IsUndefined(decorated) && !IsNull(decorated)) {
              if (!IsConstructor(decorated))
                throw new TypeError();
              target = decorated;
            }
          }
          return target;
        }
        function DecorateProperty(decorators, target, propertyKey, descriptor) {
          for (var i = decorators.length - 1; i >= 0; --i) {
            var decorator = decorators[i];
            var decorated = decorator(target, propertyKey, descriptor);
            if (!IsUndefined(decorated) && !IsNull(decorated)) {
              if (!IsObject(decorated))
                throw new TypeError();
              descriptor = decorated;
            }
          }
          return descriptor;
        }
        function OrdinaryHasMetadata(MetadataKey, O, P) {
          var hasOwn2 = OrdinaryHasOwnMetadata(MetadataKey, O, P);
          if (hasOwn2)
            return true;
          var parent = OrdinaryGetPrototypeOf(O);
          if (!IsNull(parent))
            return OrdinaryHasMetadata(MetadataKey, parent, P);
          return false;
        }
        function OrdinaryHasOwnMetadata(MetadataKey, O, P) {
          var provider = GetMetadataProvider(
            O,
            P,
            /*Create*/
            false
          );
          if (IsUndefined(provider))
            return false;
          return ToBoolean(provider.OrdinaryHasOwnMetadata(MetadataKey, O, P));
        }
        function OrdinaryGetMetadata(MetadataKey, O, P) {
          var hasOwn2 = OrdinaryHasOwnMetadata(MetadataKey, O, P);
          if (hasOwn2)
            return OrdinaryGetOwnMetadata(MetadataKey, O, P);
          var parent = OrdinaryGetPrototypeOf(O);
          if (!IsNull(parent))
            return OrdinaryGetMetadata(MetadataKey, parent, P);
          return void 0;
        }
        function OrdinaryGetOwnMetadata(MetadataKey, O, P) {
          var provider = GetMetadataProvider(
            O,
            P,
            /*Create*/
            false
          );
          if (IsUndefined(provider))
            return;
          return provider.OrdinaryGetOwnMetadata(MetadataKey, O, P);
        }
        function OrdinaryDefineOwnMetadata(MetadataKey, MetadataValue, O, P) {
          var provider = GetMetadataProvider(
            O,
            P,
            /*Create*/
            true
          );
          provider.OrdinaryDefineOwnMetadata(MetadataKey, MetadataValue, O, P);
        }
        function OrdinaryMetadataKeys(O, P) {
          var ownKeys2 = OrdinaryOwnMetadataKeys(O, P);
          var parent = OrdinaryGetPrototypeOf(O);
          if (parent === null)
            return ownKeys2;
          var parentKeys = OrdinaryMetadataKeys(parent, P);
          if (parentKeys.length <= 0)
            return ownKeys2;
          if (ownKeys2.length <= 0)
            return parentKeys;
          var set = new _Set();
          var keys = [];
          for (var _i = 0, ownKeys_1 = ownKeys2; _i < ownKeys_1.length; _i++) {
            var key = ownKeys_1[_i];
            var hasKey = set.has(key);
            if (!hasKey) {
              set.add(key);
              keys.push(key);
            }
          }
          for (var _a = 0, parentKeys_1 = parentKeys; _a < parentKeys_1.length; _a++) {
            var key = parentKeys_1[_a];
            var hasKey = set.has(key);
            if (!hasKey) {
              set.add(key);
              keys.push(key);
            }
          }
          return keys;
        }
        function OrdinaryOwnMetadataKeys(O, P) {
          var provider = GetMetadataProvider(
            O,
            P,
            /*create*/
            false
          );
          if (!provider) {
            return [];
          }
          return provider.OrdinaryOwnMetadataKeys(O, P);
        }
        function Type(x) {
          if (x === null)
            return 1;
          switch (typeof x) {
            case "undefined":
              return 0;
            case "boolean":
              return 2;
            case "string":
              return 3;
            case "symbol":
              return 4;
            case "number":
              return 5;
            case "object":
              return x === null ? 1 : 6;
            default:
              return 6;
          }
        }
        function IsUndefined(x) {
          return x === void 0;
        }
        function IsNull(x) {
          return x === null;
        }
        function IsSymbol(x) {
          return typeof x === "symbol";
        }
        function IsObject(x) {
          return typeof x === "object" ? x !== null : typeof x === "function";
        }
        function ToPrimitive(input, PreferredType) {
          switch (Type(input)) {
            case 0:
              return input;
            case 1:
              return input;
            case 2:
              return input;
            case 3:
              return input;
            case 4:
              return input;
            case 5:
              return input;
          }
          var hint = PreferredType === 3 ? "string" : PreferredType === 5 ? "number" : "default";
          var exoticToPrim = GetMethod(input, toPrimitiveSymbol);
          if (exoticToPrim !== void 0) {
            var result = exoticToPrim.call(input, hint);
            if (IsObject(result))
              throw new TypeError();
            return result;
          }
          return OrdinaryToPrimitive(input, hint === "default" ? "number" : hint);
        }
        function OrdinaryToPrimitive(O, hint) {
          if (hint === "string") {
            var toString_1 = O.toString;
            if (IsCallable(toString_1)) {
              var result = toString_1.call(O);
              if (!IsObject(result))
                return result;
            }
            var valueOf = O.valueOf;
            if (IsCallable(valueOf)) {
              var result = valueOf.call(O);
              if (!IsObject(result))
                return result;
            }
          } else {
            var valueOf = O.valueOf;
            if (IsCallable(valueOf)) {
              var result = valueOf.call(O);
              if (!IsObject(result))
                return result;
            }
            var toString_2 = O.toString;
            if (IsCallable(toString_2)) {
              var result = toString_2.call(O);
              if (!IsObject(result))
                return result;
            }
          }
          throw new TypeError();
        }
        function ToBoolean(argument) {
          return !!argument;
        }
        function ToString(argument) {
          return "" + argument;
        }
        function ToPropertyKey(argument) {
          var key = ToPrimitive(
            argument,
            3
            /* String */
          );
          if (IsSymbol(key))
            return key;
          return ToString(key);
        }
        function IsArray(argument) {
          return Array.isArray ? Array.isArray(argument) : argument instanceof Object ? argument instanceof Array : Object.prototype.toString.call(argument) === "[object Array]";
        }
        function IsCallable(argument) {
          return typeof argument === "function";
        }
        function IsConstructor(argument) {
          return typeof argument === "function";
        }
        function IsPropertyKey(argument) {
          switch (Type(argument)) {
            case 3:
              return true;
            case 4:
              return true;
            default:
              return false;
          }
        }
        function SameValueZero(x, y) {
          return x === y || x !== x && y !== y;
        }
        function GetMethod(V, P) {
          var func = V[P];
          if (func === void 0 || func === null)
            return void 0;
          if (!IsCallable(func))
            throw new TypeError();
          return func;
        }
        function GetIterator(obj) {
          var method = GetMethod(obj, iteratorSymbol);
          if (!IsCallable(method))
            throw new TypeError();
          var iterator = method.call(obj);
          if (!IsObject(iterator))
            throw new TypeError();
          return iterator;
        }
        function IteratorValue(iterResult) {
          return iterResult.value;
        }
        function IteratorStep(iterator) {
          var result = iterator.next();
          return result.done ? false : result;
        }
        function IteratorClose(iterator) {
          var f = iterator["return"];
          if (f)
            f.call(iterator);
        }
        function OrdinaryGetPrototypeOf(O) {
          var proto = Object.getPrototypeOf(O);
          if (typeof O !== "function" || O === functionPrototype)
            return proto;
          if (proto !== functionPrototype)
            return proto;
          var prototype = O.prototype;
          var prototypeProto = prototype && Object.getPrototypeOf(prototype);
          if (prototypeProto == null || prototypeProto === Object.prototype)
            return proto;
          var constructor = prototypeProto.constructor;
          if (typeof constructor !== "function")
            return proto;
          if (constructor === O)
            return proto;
          return constructor;
        }
        function CreateMetadataRegistry() {
          var fallback;
          if (!IsUndefined(registrySymbol) && typeof root.Reflect !== "undefined" && !(registrySymbol in root.Reflect) && typeof root.Reflect.defineMetadata === "function") {
            fallback = CreateFallbackProvider(root.Reflect);
          }
          var first;
          var second;
          var rest;
          var targetProviderMap = new _WeakMap();
          var registry = {
            registerProvider,
            getProvider,
            setProvider
          };
          return registry;
          function registerProvider(provider) {
            if (!Object.isExtensible(registry)) {
              throw new Error("Cannot add provider to a frozen registry.");
            }
            switch (true) {
              case fallback === provider:
                break;
              case IsUndefined(first):
                first = provider;
                break;
              case first === provider:
                break;
              case IsUndefined(second):
                second = provider;
                break;
              case second === provider:
                break;
              default:
                if (rest === void 0)
                  rest = new _Set();
                rest.add(provider);
                break;
            }
          }
          function getProviderNoCache(O, P) {
            if (!IsUndefined(first)) {
              if (first.isProviderFor(O, P))
                return first;
              if (!IsUndefined(second)) {
                if (second.isProviderFor(O, P))
                  return first;
                if (!IsUndefined(rest)) {
                  var iterator = GetIterator(rest);
                  while (true) {
                    var next = IteratorStep(iterator);
                    if (!next) {
                      return void 0;
                    }
                    var provider = IteratorValue(next);
                    if (provider.isProviderFor(O, P)) {
                      IteratorClose(iterator);
                      return provider;
                    }
                  }
                }
              }
            }
            if (!IsUndefined(fallback) && fallback.isProviderFor(O, P)) {
              return fallback;
            }
            return void 0;
          }
          function getProvider(O, P) {
            var providerMap = targetProviderMap.get(O);
            var provider;
            if (!IsUndefined(providerMap)) {
              provider = providerMap.get(P);
            }
            if (!IsUndefined(provider)) {
              return provider;
            }
            provider = getProviderNoCache(O, P);
            if (!IsUndefined(provider)) {
              if (IsUndefined(providerMap)) {
                providerMap = new _Map();
                targetProviderMap.set(O, providerMap);
              }
              providerMap.set(P, provider);
            }
            return provider;
          }
          function hasProvider(provider) {
            if (IsUndefined(provider))
              throw new TypeError();
            return first === provider || second === provider || !IsUndefined(rest) && rest.has(provider);
          }
          function setProvider(O, P, provider) {
            if (!hasProvider(provider)) {
              throw new Error("Metadata provider not registered.");
            }
            var existingProvider = getProvider(O, P);
            if (existingProvider !== provider) {
              if (!IsUndefined(existingProvider)) {
                return false;
              }
              var providerMap = targetProviderMap.get(O);
              if (IsUndefined(providerMap)) {
                providerMap = new _Map();
                targetProviderMap.set(O, providerMap);
              }
              providerMap.set(P, provider);
            }
            return true;
          }
        }
        function GetOrCreateMetadataRegistry() {
          var metadataRegistry2;
          if (!IsUndefined(registrySymbol) && IsObject(root.Reflect) && Object.isExtensible(root.Reflect)) {
            metadataRegistry2 = root.Reflect[registrySymbol];
          }
          if (IsUndefined(metadataRegistry2)) {
            metadataRegistry2 = CreateMetadataRegistry();
          }
          if (!IsUndefined(registrySymbol) && IsObject(root.Reflect) && Object.isExtensible(root.Reflect)) {
            Object.defineProperty(root.Reflect, registrySymbol, {
              enumerable: false,
              configurable: false,
              writable: false,
              value: metadataRegistry2
            });
          }
          return metadataRegistry2;
        }
        function CreateMetadataProvider(registry) {
          var metadata2 = new _WeakMap();
          var provider = {
            isProviderFor: function(O, P) {
              var targetMetadata = metadata2.get(O);
              if (IsUndefined(targetMetadata))
                return false;
              return targetMetadata.has(P);
            },
            OrdinaryDefineOwnMetadata: OrdinaryDefineOwnMetadata2,
            OrdinaryHasOwnMetadata: OrdinaryHasOwnMetadata2,
            OrdinaryGetOwnMetadata: OrdinaryGetOwnMetadata2,
            OrdinaryOwnMetadataKeys: OrdinaryOwnMetadataKeys2,
            OrdinaryDeleteMetadata
          };
          metadataRegistry.registerProvider(provider);
          return provider;
          function GetOrCreateMetadataMap(O, P, Create) {
            var targetMetadata = metadata2.get(O);
            var createdTargetMetadata = false;
            if (IsUndefined(targetMetadata)) {
              if (!Create)
                return void 0;
              targetMetadata = new _Map();
              metadata2.set(O, targetMetadata);
              createdTargetMetadata = true;
            }
            var metadataMap = targetMetadata.get(P);
            if (IsUndefined(metadataMap)) {
              if (!Create)
                return void 0;
              metadataMap = new _Map();
              targetMetadata.set(P, metadataMap);
              if (!registry.setProvider(O, P, provider)) {
                targetMetadata.delete(P);
                if (createdTargetMetadata) {
                  metadata2.delete(O);
                }
                throw new Error("Wrong provider for target.");
              }
            }
            return metadataMap;
          }
          function OrdinaryHasOwnMetadata2(MetadataKey, O, P) {
            var metadataMap = GetOrCreateMetadataMap(
              O,
              P,
              /*Create*/
              false
            );
            if (IsUndefined(metadataMap))
              return false;
            return ToBoolean(metadataMap.has(MetadataKey));
          }
          function OrdinaryGetOwnMetadata2(MetadataKey, O, P) {
            var metadataMap = GetOrCreateMetadataMap(
              O,
              P,
              /*Create*/
              false
            );
            if (IsUndefined(metadataMap))
              return void 0;
            return metadataMap.get(MetadataKey);
          }
          function OrdinaryDefineOwnMetadata2(MetadataKey, MetadataValue, O, P) {
            var metadataMap = GetOrCreateMetadataMap(
              O,
              P,
              /*Create*/
              true
            );
            metadataMap.set(MetadataKey, MetadataValue);
          }
          function OrdinaryOwnMetadataKeys2(O, P) {
            var keys = [];
            var metadataMap = GetOrCreateMetadataMap(
              O,
              P,
              /*Create*/
              false
            );
            if (IsUndefined(metadataMap))
              return keys;
            var keysObj = metadataMap.keys();
            var iterator = GetIterator(keysObj);
            var k = 0;
            while (true) {
              var next = IteratorStep(iterator);
              if (!next) {
                keys.length = k;
                return keys;
              }
              var nextValue = IteratorValue(next);
              try {
                keys[k] = nextValue;
              } catch (e) {
                try {
                  IteratorClose(iterator);
                } finally {
                  throw e;
                }
              }
              k++;
            }
          }
          function OrdinaryDeleteMetadata(MetadataKey, O, P) {
            var metadataMap = GetOrCreateMetadataMap(
              O,
              P,
              /*Create*/
              false
            );
            if (IsUndefined(metadataMap))
              return false;
            if (!metadataMap.delete(MetadataKey))
              return false;
            if (metadataMap.size === 0) {
              var targetMetadata = metadata2.get(O);
              if (!IsUndefined(targetMetadata)) {
                targetMetadata.delete(P);
                if (targetMetadata.size === 0) {
                  metadata2.delete(targetMetadata);
                }
              }
            }
            return true;
          }
        }
        function CreateFallbackProvider(reflect) {
          var defineMetadata2 = reflect.defineMetadata, hasOwnMetadata2 = reflect.hasOwnMetadata, getOwnMetadata2 = reflect.getOwnMetadata, getOwnMetadataKeys2 = reflect.getOwnMetadataKeys, deleteMetadata2 = reflect.deleteMetadata;
          var metadataOwner = new _WeakMap();
          var provider = {
            isProviderFor: function(O, P) {
              var metadataPropertySet = metadataOwner.get(O);
              if (!IsUndefined(metadataPropertySet) && metadataPropertySet.has(P)) {
                return true;
              }
              if (getOwnMetadataKeys2(O, P).length) {
                if (IsUndefined(metadataPropertySet)) {
                  metadataPropertySet = new _Set();
                  metadataOwner.set(O, metadataPropertySet);
                }
                metadataPropertySet.add(P);
                return true;
              }
              return false;
            },
            OrdinaryDefineOwnMetadata: defineMetadata2,
            OrdinaryHasOwnMetadata: hasOwnMetadata2,
            OrdinaryGetOwnMetadata: getOwnMetadata2,
            OrdinaryOwnMetadataKeys: getOwnMetadataKeys2,
            OrdinaryDeleteMetadata: deleteMetadata2
          };
          return provider;
        }
        function GetMetadataProvider(O, P, Create) {
          var registeredProvider = metadataRegistry.getProvider(O, P);
          if (!IsUndefined(registeredProvider)) {
            return registeredProvider;
          }
          if (Create) {
            if (metadataRegistry.setProvider(O, P, metadataProvider)) {
              return metadataProvider;
            }
            throw new Error("Illegal state.");
          }
          return void 0;
        }
        function CreateMapPolyfill() {
          var cacheSentinel = {};
          var arraySentinel = [];
          var MapIterator = (
            /** @class */
            (function() {
              function MapIterator2(keys, values, selector) {
                this._index = 0;
                this._keys = keys;
                this._values = values;
                this._selector = selector;
              }
              MapIterator2.prototype["@@iterator"] = function() {
                return this;
              };
              MapIterator2.prototype[iteratorSymbol] = function() {
                return this;
              };
              MapIterator2.prototype.next = function() {
                var index = this._index;
                if (index >= 0 && index < this._keys.length) {
                  var result = this._selector(this._keys[index], this._values[index]);
                  if (index + 1 >= this._keys.length) {
                    this._index = -1;
                    this._keys = arraySentinel;
                    this._values = arraySentinel;
                  } else {
                    this._index++;
                  }
                  return { value: result, done: false };
                }
                return { value: void 0, done: true };
              };
              MapIterator2.prototype.throw = function(error) {
                if (this._index >= 0) {
                  this._index = -1;
                  this._keys = arraySentinel;
                  this._values = arraySentinel;
                }
                throw error;
              };
              MapIterator2.prototype.return = function(value) {
                if (this._index >= 0) {
                  this._index = -1;
                  this._keys = arraySentinel;
                  this._values = arraySentinel;
                }
                return { value, done: true };
              };
              return MapIterator2;
            })()
          );
          var Map2 = (
            /** @class */
            (function() {
              function Map3() {
                this._keys = [];
                this._values = [];
                this._cacheKey = cacheSentinel;
                this._cacheIndex = -2;
              }
              Object.defineProperty(Map3.prototype, "size", {
                get: function() {
                  return this._keys.length;
                },
                enumerable: true,
                configurable: true
              });
              Map3.prototype.has = function(key) {
                return this._find(
                  key,
                  /*insert*/
                  false
                ) >= 0;
              };
              Map3.prototype.get = function(key) {
                var index = this._find(
                  key,
                  /*insert*/
                  false
                );
                return index >= 0 ? this._values[index] : void 0;
              };
              Map3.prototype.set = function(key, value) {
                var index = this._find(
                  key,
                  /*insert*/
                  true
                );
                this._values[index] = value;
                return this;
              };
              Map3.prototype.delete = function(key) {
                var index = this._find(
                  key,
                  /*insert*/
                  false
                );
                if (index >= 0) {
                  var size = this._keys.length;
                  for (var i = index + 1; i < size; i++) {
                    this._keys[i - 1] = this._keys[i];
                    this._values[i - 1] = this._values[i];
                  }
                  this._keys.length--;
                  this._values.length--;
                  if (SameValueZero(key, this._cacheKey)) {
                    this._cacheKey = cacheSentinel;
                    this._cacheIndex = -2;
                  }
                  return true;
                }
                return false;
              };
              Map3.prototype.clear = function() {
                this._keys.length = 0;
                this._values.length = 0;
                this._cacheKey = cacheSentinel;
                this._cacheIndex = -2;
              };
              Map3.prototype.keys = function() {
                return new MapIterator(this._keys, this._values, getKey);
              };
              Map3.prototype.values = function() {
                return new MapIterator(this._keys, this._values, getValue);
              };
              Map3.prototype.entries = function() {
                return new MapIterator(this._keys, this._values, getEntry);
              };
              Map3.prototype["@@iterator"] = function() {
                return this.entries();
              };
              Map3.prototype[iteratorSymbol] = function() {
                return this.entries();
              };
              Map3.prototype._find = function(key, insert) {
                if (!SameValueZero(this._cacheKey, key)) {
                  this._cacheIndex = -1;
                  for (var i = 0; i < this._keys.length; i++) {
                    if (SameValueZero(this._keys[i], key)) {
                      this._cacheIndex = i;
                      break;
                    }
                  }
                }
                if (this._cacheIndex < 0 && insert) {
                  this._cacheIndex = this._keys.length;
                  this._keys.push(key);
                  this._values.push(void 0);
                }
                return this._cacheIndex;
              };
              return Map3;
            })()
          );
          return Map2;
          function getKey(key, _) {
            return key;
          }
          function getValue(_, value) {
            return value;
          }
          function getEntry(key, value) {
            return [key, value];
          }
        }
        function CreateSetPolyfill() {
          var Set2 = (
            /** @class */
            (function() {
              function Set3() {
                this._map = new _Map();
              }
              Object.defineProperty(Set3.prototype, "size", {
                get: function() {
                  return this._map.size;
                },
                enumerable: true,
                configurable: true
              });
              Set3.prototype.has = function(value) {
                return this._map.has(value);
              };
              Set3.prototype.add = function(value) {
                return this._map.set(value, value), this;
              };
              Set3.prototype.delete = function(value) {
                return this._map.delete(value);
              };
              Set3.prototype.clear = function() {
                this._map.clear();
              };
              Set3.prototype.keys = function() {
                return this._map.keys();
              };
              Set3.prototype.values = function() {
                return this._map.keys();
              };
              Set3.prototype.entries = function() {
                return this._map.entries();
              };
              Set3.prototype["@@iterator"] = function() {
                return this.keys();
              };
              Set3.prototype[iteratorSymbol] = function() {
                return this.keys();
              };
              return Set3;
            })()
          );
          return Set2;
        }
        function CreateWeakMapPolyfill() {
          var UUID_SIZE = 16;
          var keys = HashMap.create();
          var rootKey = CreateUniqueKey();
          return (
            /** @class */
            (function() {
              function WeakMap2() {
                this._key = CreateUniqueKey();
              }
              WeakMap2.prototype.has = function(target) {
                var table = GetOrCreateWeakMapTable(
                  target,
                  /*create*/
                  false
                );
                return table !== void 0 ? HashMap.has(table, this._key) : false;
              };
              WeakMap2.prototype.get = function(target) {
                var table = GetOrCreateWeakMapTable(
                  target,
                  /*create*/
                  false
                );
                return table !== void 0 ? HashMap.get(table, this._key) : void 0;
              };
              WeakMap2.prototype.set = function(target, value) {
                var table = GetOrCreateWeakMapTable(
                  target,
                  /*create*/
                  true
                );
                table[this._key] = value;
                return this;
              };
              WeakMap2.prototype.delete = function(target) {
                var table = GetOrCreateWeakMapTable(
                  target,
                  /*create*/
                  false
                );
                return table !== void 0 ? delete table[this._key] : false;
              };
              WeakMap2.prototype.clear = function() {
                this._key = CreateUniqueKey();
              };
              return WeakMap2;
            })()
          );
          function CreateUniqueKey() {
            var key;
            do
              key = "@@WeakMap@@" + CreateUUID();
            while (HashMap.has(keys, key));
            keys[key] = true;
            return key;
          }
          function GetOrCreateWeakMapTable(target, create) {
            if (!hasOwn.call(target, rootKey)) {
              if (!create)
                return void 0;
              Object.defineProperty(target, rootKey, { value: HashMap.create() });
            }
            return target[rootKey];
          }
          function FillRandomBytes(buffer, size) {
            for (var i = 0; i < size; ++i)
              buffer[i] = Math.random() * 255 | 0;
            return buffer;
          }
          function GenRandomBytes(size) {
            if (typeof Uint8Array === "function") {
              var array = new Uint8Array(size);
              if (typeof crypto !== "undefined") {
                crypto.getRandomValues(array);
              } else if (typeof msCrypto !== "undefined") {
                msCrypto.getRandomValues(array);
              } else {
                FillRandomBytes(array, size);
              }
              return array;
            }
            return FillRandomBytes(new Array(size), size);
          }
          function CreateUUID() {
            var data = GenRandomBytes(UUID_SIZE);
            data[6] = data[6] & 79 | 64;
            data[8] = data[8] & 191 | 128;
            var result = "";
            for (var offset = 0; offset < UUID_SIZE; ++offset) {
              var byte = data[offset];
              if (offset === 4 || offset === 6 || offset === 8)
                result += "-";
              if (byte < 16)
                result += "0";
              result += byte.toString(16).toLowerCase();
            }
            return result;
          }
        }
        function MakeDictionary(obj) {
          obj.__ = void 0;
          delete obj.__;
          return obj;
        }
      });
    })(Reflect2 || (Reflect2 = {}));
  }
});

// node_modules/tslib/tslib.es6.mjs
var tslib_es6_exports = {};
__export(tslib_es6_exports, {
  __addDisposableResource: () => __addDisposableResource,
  __assign: () => __assign,
  __asyncDelegator: () => __asyncDelegator,
  __asyncGenerator: () => __asyncGenerator,
  __asyncValues: () => __asyncValues,
  __await: () => __await,
  __awaiter: () => __awaiter,
  __classPrivateFieldGet: () => __classPrivateFieldGet,
  __classPrivateFieldIn: () => __classPrivateFieldIn,
  __classPrivateFieldSet: () => __classPrivateFieldSet,
  __createBinding: () => __createBinding,
  __decorate: () => __decorate,
  __disposeResources: () => __disposeResources,
  __esDecorate: () => __esDecorate,
  __exportStar: () => __exportStar,
  __extends: () => __extends,
  __generator: () => __generator,
  __importDefault: () => __importDefault,
  __importStar: () => __importStar,
  __makeTemplateObject: () => __makeTemplateObject,
  __metadata: () => __metadata,
  __param: () => __param,
  __propKey: () => __propKey,
  __read: () => __read,
  __rest: () => __rest,
  __rewriteRelativeImportExtension: () => __rewriteRelativeImportExtension,
  __runInitializers: () => __runInitializers,
  __setFunctionName: () => __setFunctionName,
  __spread: () => __spread,
  __spreadArray: () => __spreadArray,
  __spreadArrays: () => __spreadArrays,
  __values: () => __values,
  default: () => tslib_es6_default
});
function __extends(d, b) {
  if (typeof b !== "function" && b !== null)
    throw new TypeError("Class extends value " + String(b) + " is not a constructor or null");
  extendStatics(d, b);
  function __() {
    this.constructor = d;
  }
  d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
}
function __rest(s, e) {
  var t = {};
  for (var p in s) if (Object.prototype.hasOwnProperty.call(s, p) && e.indexOf(p) < 0)
    t[p] = s[p];
  if (s != null && typeof Object.getOwnPropertySymbols === "function")
    for (var i = 0, p = Object.getOwnPropertySymbols(s); i < p.length; i++) {
      if (e.indexOf(p[i]) < 0 && Object.prototype.propertyIsEnumerable.call(s, p[i]))
        t[p[i]] = s[p[i]];
    }
  return t;
}
function __decorate(decorators, target, key, desc) {
  var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
  if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
  else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
  return c > 3 && r && Object.defineProperty(target, key, r), r;
}
function __param(paramIndex, decorator) {
  return function(target, key) {
    decorator(target, key, paramIndex);
  };
}
function __esDecorate(ctor, descriptorIn, decorators, contextIn, initializers, extraInitializers) {
  function accept(f) {
    if (f !== void 0 && typeof f !== "function") throw new TypeError("Function expected");
    return f;
  }
  var kind = contextIn.kind, key = kind === "getter" ? "get" : kind === "setter" ? "set" : "value";
  var target = !descriptorIn && ctor ? contextIn["static"] ? ctor : ctor.prototype : null;
  var descriptor = descriptorIn || (target ? Object.getOwnPropertyDescriptor(target, contextIn.name) : {});
  var _, done = false;
  for (var i = decorators.length - 1; i >= 0; i--) {
    var context = {};
    for (var p in contextIn) context[p] = p === "access" ? {} : contextIn[p];
    for (var p in contextIn.access) context.access[p] = contextIn.access[p];
    context.addInitializer = function(f) {
      if (done) throw new TypeError("Cannot add initializers after decoration has completed");
      extraInitializers.push(accept(f || null));
    };
    var result = (0, decorators[i])(kind === "accessor" ? { get: descriptor.get, set: descriptor.set } : descriptor[key], context);
    if (kind === "accessor") {
      if (result === void 0) continue;
      if (result === null || typeof result !== "object") throw new TypeError("Object expected");
      if (_ = accept(result.get)) descriptor.get = _;
      if (_ = accept(result.set)) descriptor.set = _;
      if (_ = accept(result.init)) initializers.unshift(_);
    } else if (_ = accept(result)) {
      if (kind === "field") initializers.unshift(_);
      else descriptor[key] = _;
    }
  }
  if (target) Object.defineProperty(target, contextIn.name, descriptor);
  done = true;
}
function __runInitializers(thisArg, initializers, value) {
  var useValue = arguments.length > 2;
  for (var i = 0; i < initializers.length; i++) {
    value = useValue ? initializers[i].call(thisArg, value) : initializers[i].call(thisArg);
  }
  return useValue ? value : void 0;
}
function __propKey(x) {
  return typeof x === "symbol" ? x : "".concat(x);
}
function __setFunctionName(f, name, prefix) {
  if (typeof name === "symbol") name = name.description ? "[".concat(name.description, "]") : "";
  return Object.defineProperty(f, "name", { configurable: true, value: prefix ? "".concat(prefix, " ", name) : name });
}
function __metadata(metadataKey, metadataValue) {
  if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(metadataKey, metadataValue);
}
function __awaiter(thisArg, _arguments, P, generator) {
  function adopt(value) {
    return value instanceof P ? value : new P(function(resolve) {
      resolve(value);
    });
  }
  return new (P || (P = Promise))(function(resolve, reject) {
    function fulfilled(value) {
      try {
        step(generator.next(value));
      } catch (e) {
        reject(e);
      }
    }
    function rejected(value) {
      try {
        step(generator["throw"](value));
      } catch (e) {
        reject(e);
      }
    }
    function step(result) {
      result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected);
    }
    step((generator = generator.apply(thisArg, _arguments || [])).next());
  });
}
function __generator(thisArg, body) {
  var _ = { label: 0, sent: function() {
    if (t[0] & 1) throw t[1];
    return t[1];
  }, trys: [], ops: [] }, f, y, t, g = Object.create((typeof Iterator === "function" ? Iterator : Object).prototype);
  return g.next = verb(0), g["throw"] = verb(1), g["return"] = verb(2), typeof Symbol === "function" && (g[Symbol.iterator] = function() {
    return this;
  }), g;
  function verb(n) {
    return function(v) {
      return step([n, v]);
    };
  }
  function step(op) {
    if (f) throw new TypeError("Generator is already executing.");
    while (g && (g = 0, op[0] && (_ = 0)), _) try {
      if (f = 1, y && (t = op[0] & 2 ? y["return"] : op[0] ? y["throw"] || ((t = y["return"]) && t.call(y), 0) : y.next) && !(t = t.call(y, op[1])).done) return t;
      if (y = 0, t) op = [op[0] & 2, t.value];
      switch (op[0]) {
        case 0:
        case 1:
          t = op;
          break;
        case 4:
          _.label++;
          return { value: op[1], done: false };
        case 5:
          _.label++;
          y = op[1];
          op = [0];
          continue;
        case 7:
          op = _.ops.pop();
          _.trys.pop();
          continue;
        default:
          if (!(t = _.trys, t = t.length > 0 && t[t.length - 1]) && (op[0] === 6 || op[0] === 2)) {
            _ = 0;
            continue;
          }
          if (op[0] === 3 && (!t || op[1] > t[0] && op[1] < t[3])) {
            _.label = op[1];
            break;
          }
          if (op[0] === 6 && _.label < t[1]) {
            _.label = t[1];
            t = op;
            break;
          }
          if (t && _.label < t[2]) {
            _.label = t[2];
            _.ops.push(op);
            break;
          }
          if (t[2]) _.ops.pop();
          _.trys.pop();
          continue;
      }
      op = body.call(thisArg, _);
    } catch (e) {
      op = [6, e];
      y = 0;
    } finally {
      f = t = 0;
    }
    if (op[0] & 5) throw op[1];
    return { value: op[0] ? op[1] : void 0, done: true };
  }
}
function __exportStar(m, o) {
  for (var p in m) if (p !== "default" && !Object.prototype.hasOwnProperty.call(o, p)) __createBinding(o, m, p);
}
function __values(o) {
  var s = typeof Symbol === "function" && Symbol.iterator, m = s && o[s], i = 0;
  if (m) return m.call(o);
  if (o && typeof o.length === "number") return {
    next: function() {
      if (o && i >= o.length) o = void 0;
      return { value: o && o[i++], done: !o };
    }
  };
  throw new TypeError(s ? "Object is not iterable." : "Symbol.iterator is not defined.");
}
function __read(o, n) {
  var m = typeof Symbol === "function" && o[Symbol.iterator];
  if (!m) return o;
  var i = m.call(o), r, ar = [], e;
  try {
    while ((n === void 0 || n-- > 0) && !(r = i.next()).done) ar.push(r.value);
  } catch (error) {
    e = { error };
  } finally {
    try {
      if (r && !r.done && (m = i["return"])) m.call(i);
    } finally {
      if (e) throw e.error;
    }
  }
  return ar;
}
function __spread() {
  for (var ar = [], i = 0; i < arguments.length; i++)
    ar = ar.concat(__read(arguments[i]));
  return ar;
}
function __spreadArrays() {
  for (var s = 0, i = 0, il = arguments.length; i < il; i++) s += arguments[i].length;
  for (var r = Array(s), k = 0, i = 0; i < il; i++)
    for (var a = arguments[i], j = 0, jl = a.length; j < jl; j++, k++)
      r[k] = a[j];
  return r;
}
function __spreadArray(to, from, pack) {
  if (pack || arguments.length === 2) for (var i = 0, l = from.length, ar; i < l; i++) {
    if (ar || !(i in from)) {
      if (!ar) ar = Array.prototype.slice.call(from, 0, i);
      ar[i] = from[i];
    }
  }
  return to.concat(ar || Array.prototype.slice.call(from));
}
function __await(v) {
  return this instanceof __await ? (this.v = v, this) : new __await(v);
}
function __asyncGenerator(thisArg, _arguments, generator) {
  if (!Symbol.asyncIterator) throw new TypeError("Symbol.asyncIterator is not defined.");
  var g = generator.apply(thisArg, _arguments || []), i, q = [];
  return i = Object.create((typeof AsyncIterator === "function" ? AsyncIterator : Object).prototype), verb("next"), verb("throw"), verb("return", awaitReturn), i[Symbol.asyncIterator] = function() {
    return this;
  }, i;
  function awaitReturn(f) {
    return function(v) {
      return Promise.resolve(v).then(f, reject);
    };
  }
  function verb(n, f) {
    if (g[n]) {
      i[n] = function(v) {
        return new Promise(function(a, b) {
          q.push([n, v, a, b]) > 1 || resume(n, v);
        });
      };
      if (f) i[n] = f(i[n]);
    }
  }
  function resume(n, v) {
    try {
      step(g[n](v));
    } catch (e) {
      settle(q[0][3], e);
    }
  }
  function step(r) {
    r.value instanceof __await ? Promise.resolve(r.value.v).then(fulfill, reject) : settle(q[0][2], r);
  }
  function fulfill(value) {
    resume("next", value);
  }
  function reject(value) {
    resume("throw", value);
  }
  function settle(f, v) {
    if (f(v), q.shift(), q.length) resume(q[0][0], q[0][1]);
  }
}
function __asyncDelegator(o) {
  var i, p;
  return i = {}, verb("next"), verb("throw", function(e) {
    throw e;
  }), verb("return"), i[Symbol.iterator] = function() {
    return this;
  }, i;
  function verb(n, f) {
    i[n] = o[n] ? function(v) {
      return (p = !p) ? { value: __await(o[n](v)), done: false } : f ? f(v) : v;
    } : f;
  }
}
function __asyncValues(o) {
  if (!Symbol.asyncIterator) throw new TypeError("Symbol.asyncIterator is not defined.");
  var m = o[Symbol.asyncIterator], i;
  return m ? m.call(o) : (o = typeof __values === "function" ? __values(o) : o[Symbol.iterator](), i = {}, verb("next"), verb("throw"), verb("return"), i[Symbol.asyncIterator] = function() {
    return this;
  }, i);
  function verb(n) {
    i[n] = o[n] && function(v) {
      return new Promise(function(resolve, reject) {
        v = o[n](v), settle(resolve, reject, v.done, v.value);
      });
    };
  }
  function settle(resolve, reject, d, v) {
    Promise.resolve(v).then(function(v2) {
      resolve({ value: v2, done: d });
    }, reject);
  }
}
function __makeTemplateObject(cooked, raw) {
  if (Object.defineProperty) {
    Object.defineProperty(cooked, "raw", { value: raw });
  } else {
    cooked.raw = raw;
  }
  return cooked;
}
function __importStar(mod) {
  if (mod && mod.__esModule) return mod;
  var result = {};
  if (mod != null) {
    for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
  }
  __setModuleDefault(result, mod);
  return result;
}
function __importDefault(mod) {
  return mod && mod.__esModule ? mod : { default: mod };
}
function __classPrivateFieldGet(receiver, state, kind, f) {
  if (kind === "a" && !f) throw new TypeError("Private accessor was defined without a getter");
  if (typeof state === "function" ? receiver !== state || !f : !state.has(receiver)) throw new TypeError("Cannot read private member from an object whose class did not declare it");
  return kind === "m" ? f : kind === "a" ? f.call(receiver) : f ? f.value : state.get(receiver);
}
function __classPrivateFieldSet(receiver, state, value, kind, f) {
  if (kind === "m") throw new TypeError("Private method is not writable");
  if (kind === "a" && !f) throw new TypeError("Private accessor was defined without a setter");
  if (typeof state === "function" ? receiver !== state || !f : !state.has(receiver)) throw new TypeError("Cannot write private member to an object whose class did not declare it");
  return kind === "a" ? f.call(receiver, value) : f ? f.value = value : state.set(receiver, value), value;
}
function __classPrivateFieldIn(state, receiver) {
  if (receiver === null || typeof receiver !== "object" && typeof receiver !== "function") throw new TypeError("Cannot use 'in' operator on non-object");
  return typeof state === "function" ? receiver === state : state.has(receiver);
}
function __addDisposableResource(env, value, async) {
  if (value !== null && value !== void 0) {
    if (typeof value !== "object" && typeof value !== "function") throw new TypeError("Object expected.");
    var dispose, inner;
    if (async) {
      if (!Symbol.asyncDispose) throw new TypeError("Symbol.asyncDispose is not defined.");
      dispose = value[Symbol.asyncDispose];
    }
    if (dispose === void 0) {
      if (!Symbol.dispose) throw new TypeError("Symbol.dispose is not defined.");
      dispose = value[Symbol.dispose];
      if (async) inner = dispose;
    }
    if (typeof dispose !== "function") throw new TypeError("Object not disposable.");
    if (inner) dispose = function() {
      try {
        inner.call(this);
      } catch (e) {
        return Promise.reject(e);
      }
    };
    env.stack.push({ value, dispose, async });
  } else if (async) {
    env.stack.push({ async: true });
  }
  return value;
}
function __disposeResources(env) {
  function fail(e) {
    env.error = env.hasError ? new _SuppressedError(e, env.error, "An error was suppressed during disposal.") : e;
    env.hasError = true;
  }
  var r, s = 0;
  function next() {
    while (r = env.stack.pop()) {
      try {
        if (!r.async && s === 1) return s = 0, env.stack.push(r), Promise.resolve().then(next);
        if (r.dispose) {
          var result = r.dispose.call(r.value);
          if (r.async) return s |= 2, Promise.resolve(result).then(next, function(e) {
            fail(e);
            return next();
          });
        } else s |= 1;
      } catch (e) {
        fail(e);
      }
    }
    if (s === 1) return env.hasError ? Promise.reject(env.error) : Promise.resolve();
    if (env.hasError) throw env.error;
  }
  return next();
}
function __rewriteRelativeImportExtension(path, preserveJsx) {
  if (typeof path === "string" && /^\.\.?\//.test(path)) {
    return path.replace(/\.(tsx)$|((?:\.d)?)((?:\.[^./]+?)?)\.([cm]?)ts$/i, function(m, tsx, d, ext, cm) {
      return tsx ? preserveJsx ? ".jsx" : ".js" : d && (!ext || !cm) ? m : d + ext + "." + cm.toLowerCase() + "js";
    });
  }
  return path;
}
var extendStatics, __assign, __createBinding, __setModuleDefault, ownKeys, _SuppressedError, tslib_es6_default;
var init_tslib_es6 = __esm({
  "node_modules/tslib/tslib.es6.mjs"() {
    extendStatics = function(d, b) {
      extendStatics = Object.setPrototypeOf || { __proto__: [] } instanceof Array && function(d2, b2) {
        d2.__proto__ = b2;
      } || function(d2, b2) {
        for (var p in b2) if (Object.prototype.hasOwnProperty.call(b2, p)) d2[p] = b2[p];
      };
      return extendStatics(d, b);
    };
    __assign = function() {
      __assign = Object.assign || function __assign3(t) {
        for (var s, i = 1, n = arguments.length; i < n; i++) {
          s = arguments[i];
          for (var p in s) if (Object.prototype.hasOwnProperty.call(s, p)) t[p] = s[p];
        }
        return t;
      };
      return __assign.apply(this, arguments);
    };
    __createBinding = Object.create ? (function(o, m, k, k2) {
      if (k2 === void 0) k2 = k;
      var desc = Object.getOwnPropertyDescriptor(m, k);
      if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
        desc = { enumerable: true, get: function() {
          return m[k];
        } };
      }
      Object.defineProperty(o, k2, desc);
    }) : (function(o, m, k, k2) {
      if (k2 === void 0) k2 = k;
      o[k2] = m[k];
    });
    __setModuleDefault = Object.create ? (function(o, v) {
      Object.defineProperty(o, "default", { enumerable: true, value: v });
    }) : function(o, v) {
      o["default"] = v;
    };
    ownKeys = function(o) {
      ownKeys = Object.getOwnPropertyNames || function(o2) {
        var ar = [];
        for (var k in o2) if (Object.prototype.hasOwnProperty.call(o2, k)) ar[ar.length] = k;
        return ar;
      };
      return ownKeys(o);
    };
    _SuppressedError = typeof SuppressedError === "function" ? SuppressedError : function(error, suppressed, message) {
      var e = new Error(message);
      return e.name = "SuppressedError", e.error = error, e.suppressed = suppressed, e;
    };
    tslib_es6_default = {
      __extends,
      __assign,
      __rest,
      __decorate,
      __param,
      __esDecorate,
      __runInitializers,
      __propKey,
      __setFunctionName,
      __metadata,
      __awaiter,
      __generator,
      __createBinding,
      __exportStar,
      __values,
      __read,
      __spread,
      __spreadArrays,
      __spreadArray,
      __await,
      __asyncGenerator,
      __asyncDelegator,
      __asyncValues,
      __makeTemplateObject,
      __importStar,
      __importDefault,
      __classPrivateFieldGet,
      __classPrivateFieldSet,
      __classPrivateFieldIn,
      __addDisposableResource,
      __disposeResources,
      __rewriteRelativeImportExtension
    };
  }
});

// node_modules/pvtsutils/build/index.js
var require_build = __commonJS({
  "node_modules/pvtsutils/build/index.js"(exports) {
    "use strict";
    var ARRAY_BUFFER_NAME = "[object ArrayBuffer]";
    var BufferSourceConverter = class _BufferSourceConverter {
      static isArrayBuffer(data) {
        return Object.prototype.toString.call(data) === ARRAY_BUFFER_NAME;
      }
      static toArrayBuffer(data) {
        if (this.isArrayBuffer(data)) {
          return data;
        }
        if (data.byteLength === data.buffer.byteLength) {
          return data.buffer;
        }
        if (data.byteOffset === 0 && data.byteLength === data.buffer.byteLength) {
          return data.buffer;
        }
        return this.toUint8Array(data.buffer).slice(data.byteOffset, data.byteOffset + data.byteLength).buffer;
      }
      static toUint8Array(data) {
        return this.toView(data, Uint8Array);
      }
      static toView(data, type) {
        if (data.constructor === type) {
          return data;
        }
        if (this.isArrayBuffer(data)) {
          return new type(data);
        }
        if (this.isArrayBufferView(data)) {
          return new type(data.buffer, data.byteOffset, data.byteLength);
        }
        throw new TypeError("The provided value is not of type '(ArrayBuffer or ArrayBufferView)'");
      }
      static isBufferSource(data) {
        return this.isArrayBufferView(data) || this.isArrayBuffer(data);
      }
      static isArrayBufferView(data) {
        return ArrayBuffer.isView(data) || data && this.isArrayBuffer(data.buffer);
      }
      static isEqual(a, b) {
        const aView = _BufferSourceConverter.toUint8Array(a);
        const bView = _BufferSourceConverter.toUint8Array(b);
        if (aView.length !== bView.byteLength) {
          return false;
        }
        for (let i = 0; i < aView.length; i++) {
          if (aView[i] !== bView[i]) {
            return false;
          }
        }
        return true;
      }
      static concat(...args) {
        let buffers;
        if (Array.isArray(args[0]) && !(args[1] instanceof Function)) {
          buffers = args[0];
        } else if (Array.isArray(args[0]) && args[1] instanceof Function) {
          buffers = args[0];
        } else {
          if (args[args.length - 1] instanceof Function) {
            buffers = args.slice(0, args.length - 1);
          } else {
            buffers = args;
          }
        }
        let size = 0;
        for (const buffer of buffers) {
          size += buffer.byteLength;
        }
        const res = new Uint8Array(size);
        let offset = 0;
        for (const buffer of buffers) {
          const view = this.toUint8Array(buffer);
          res.set(view, offset);
          offset += view.length;
        }
        if (args[args.length - 1] instanceof Function) {
          return this.toView(res, args[args.length - 1]);
        }
        return res.buffer;
      }
    };
    var STRING_TYPE = "string";
    var HEX_REGEX = /^[0-9a-f\s]+$/i;
    var BASE64_REGEX = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
    var BASE64URL_REGEX = /^[a-zA-Z0-9-_]+$/;
    var Utf8Converter = class {
      static fromString(text) {
        const s = unescape(encodeURIComponent(text));
        const uintArray = new Uint8Array(s.length);
        for (let i = 0; i < s.length; i++) {
          uintArray[i] = s.charCodeAt(i);
        }
        return uintArray.buffer;
      }
      static toString(buffer) {
        const buf = BufferSourceConverter.toUint8Array(buffer);
        let encodedString = "";
        for (let i = 0; i < buf.length; i++) {
          encodedString += String.fromCharCode(buf[i]);
        }
        const decodedString = decodeURIComponent(escape(encodedString));
        return decodedString;
      }
    };
    var Utf16Converter = class {
      static toString(buffer, littleEndian = false) {
        const arrayBuffer = BufferSourceConverter.toArrayBuffer(buffer);
        const dataView = new DataView(arrayBuffer);
        let res = "";
        for (let i = 0; i < arrayBuffer.byteLength; i += 2) {
          const code = dataView.getUint16(i, littleEndian);
          res += String.fromCharCode(code);
        }
        return res;
      }
      static fromString(text, littleEndian = false) {
        const res = new ArrayBuffer(text.length * 2);
        const dataView = new DataView(res);
        for (let i = 0; i < text.length; i++) {
          dataView.setUint16(i * 2, text.charCodeAt(i), littleEndian);
        }
        return res;
      }
    };
    var Convert = class _Convert {
      static isHex(data) {
        return typeof data === STRING_TYPE && HEX_REGEX.test(data);
      }
      static isBase64(data) {
        return typeof data === STRING_TYPE && BASE64_REGEX.test(data);
      }
      static isBase64Url(data) {
        return typeof data === STRING_TYPE && BASE64URL_REGEX.test(data);
      }
      static ToString(buffer, enc = "utf8") {
        const buf = BufferSourceConverter.toUint8Array(buffer);
        switch (enc.toLowerCase()) {
          case "utf8":
            return this.ToUtf8String(buf);
          case "binary":
            return this.ToBinary(buf);
          case "hex":
            return this.ToHex(buf);
          case "base64":
            return this.ToBase64(buf);
          case "base64url":
            return this.ToBase64Url(buf);
          case "utf16le":
            return Utf16Converter.toString(buf, true);
          case "utf16":
          case "utf16be":
            return Utf16Converter.toString(buf);
          default:
            throw new Error(`Unknown type of encoding '${enc}'`);
        }
      }
      static FromString(str, enc = "utf8") {
        if (!str) {
          return new ArrayBuffer(0);
        }
        switch (enc.toLowerCase()) {
          case "utf8":
            return this.FromUtf8String(str);
          case "binary":
            return this.FromBinary(str);
          case "hex":
            return this.FromHex(str);
          case "base64":
            return this.FromBase64(str);
          case "base64url":
            return this.FromBase64Url(str);
          case "utf16le":
            return Utf16Converter.fromString(str, true);
          case "utf16":
          case "utf16be":
            return Utf16Converter.fromString(str);
          default:
            throw new Error(`Unknown type of encoding '${enc}'`);
        }
      }
      static ToBase64(buffer) {
        const buf = BufferSourceConverter.toUint8Array(buffer);
        if (typeof btoa !== "undefined") {
          const binary = this.ToString(buf, "binary");
          return btoa(binary);
        } else {
          return Buffer.from(buf).toString("base64");
        }
      }
      static FromBase64(base64) {
        const formatted = this.formatString(base64);
        if (!formatted) {
          return new ArrayBuffer(0);
        }
        if (!_Convert.isBase64(formatted)) {
          throw new TypeError("Argument 'base64Text' is not Base64 encoded");
        }
        if (typeof atob !== "undefined") {
          return this.FromBinary(atob(formatted));
        } else {
          return new Uint8Array(Buffer.from(formatted, "base64")).buffer;
        }
      }
      static FromBase64Url(base64url) {
        const formatted = this.formatString(base64url);
        if (!formatted) {
          return new ArrayBuffer(0);
        }
        if (!_Convert.isBase64Url(formatted)) {
          throw new TypeError("Argument 'base64url' is not Base64Url encoded");
        }
        return this.FromBase64(this.Base64Padding(formatted.replace(/\-/g, "+").replace(/\_/g, "/")));
      }
      static ToBase64Url(data) {
        return this.ToBase64(data).replace(/\+/g, "-").replace(/\//g, "_").replace(/\=/g, "");
      }
      static FromUtf8String(text, encoding = _Convert.DEFAULT_UTF8_ENCODING) {
        switch (encoding) {
          case "ascii":
            return this.FromBinary(text);
          case "utf8":
            return Utf8Converter.fromString(text);
          case "utf16":
          case "utf16be":
            return Utf16Converter.fromString(text);
          case "utf16le":
          case "usc2":
            return Utf16Converter.fromString(text, true);
          default:
            throw new Error(`Unknown type of encoding '${encoding}'`);
        }
      }
      static ToUtf8String(buffer, encoding = _Convert.DEFAULT_UTF8_ENCODING) {
        switch (encoding) {
          case "ascii":
            return this.ToBinary(buffer);
          case "utf8":
            return Utf8Converter.toString(buffer);
          case "utf16":
          case "utf16be":
            return Utf16Converter.toString(buffer);
          case "utf16le":
          case "usc2":
            return Utf16Converter.toString(buffer, true);
          default:
            throw new Error(`Unknown type of encoding '${encoding}'`);
        }
      }
      static FromBinary(text) {
        const stringLength = text.length;
        const resultView = new Uint8Array(stringLength);
        for (let i = 0; i < stringLength; i++) {
          resultView[i] = text.charCodeAt(i);
        }
        return resultView.buffer;
      }
      static ToBinary(buffer) {
        const buf = BufferSourceConverter.toUint8Array(buffer);
        let res = "";
        for (let i = 0; i < buf.length; i++) {
          res += String.fromCharCode(buf[i]);
        }
        return res;
      }
      static ToHex(buffer) {
        const buf = BufferSourceConverter.toUint8Array(buffer);
        let result = "";
        const len = buf.length;
        for (let i = 0; i < len; i++) {
          const byte = buf[i];
          if (byte < 16) {
            result += "0";
          }
          result += byte.toString(16);
        }
        return result;
      }
      static FromHex(hexString) {
        let formatted = this.formatString(hexString);
        if (!formatted) {
          return new ArrayBuffer(0);
        }
        if (!_Convert.isHex(formatted)) {
          throw new TypeError("Argument 'hexString' is not HEX encoded");
        }
        if (formatted.length % 2) {
          formatted = `0${formatted}`;
        }
        const res = new Uint8Array(formatted.length / 2);
        for (let i = 0; i < formatted.length; i = i + 2) {
          const c = formatted.slice(i, i + 2);
          res[i / 2] = parseInt(c, 16);
        }
        return res.buffer;
      }
      static ToUtf16String(buffer, littleEndian = false) {
        return Utf16Converter.toString(buffer, littleEndian);
      }
      static FromUtf16String(text, littleEndian = false) {
        return Utf16Converter.fromString(text, littleEndian);
      }
      static Base64Padding(base64) {
        const padCount = 4 - base64.length % 4;
        if (padCount < 4) {
          for (let i = 0; i < padCount; i++) {
            base64 += "=";
          }
        }
        return base64;
      }
      static formatString(data) {
        return (data === null || data === void 0 ? void 0 : data.replace(/[\n\r\t ]/g, "")) || "";
      }
    };
    Convert.DEFAULT_UTF8_ENCODING = "utf8";
    function assign(target, ...sources) {
      const res = arguments[0];
      for (let i = 1; i < arguments.length; i++) {
        const obj = arguments[i];
        for (const prop in obj) {
          res[prop] = obj[prop];
        }
      }
      return res;
    }
    function combine(...buf) {
      const totalByteLength = buf.map((item) => item.byteLength).reduce((prev, cur) => prev + cur);
      const res = new Uint8Array(totalByteLength);
      let currentPos = 0;
      buf.map((item) => new Uint8Array(item)).forEach((arr) => {
        for (const item2 of arr) {
          res[currentPos++] = item2;
        }
      });
      return res.buffer;
    }
    function isEqual(bytes1, bytes2) {
      if (!(bytes1 && bytes2)) {
        return false;
      }
      if (bytes1.byteLength !== bytes2.byteLength) {
        return false;
      }
      const b1 = new Uint8Array(bytes1);
      const b2 = new Uint8Array(bytes2);
      for (let i = 0; i < bytes1.byteLength; i++) {
        if (b1[i] !== b2[i]) {
          return false;
        }
      }
      return true;
    }
    exports.BufferSourceConverter = BufferSourceConverter;
    exports.Convert = Convert;
    exports.assign = assign;
    exports.combine = combine;
    exports.isEqual = isEqual;
  }
});

// node_modules/pvutils/build/utils.js
var require_utils = __commonJS({
  "node_modules/pvutils/build/utils.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    function getUTCDate(date) {
      return new Date(date.getTime() + date.getTimezoneOffset() * 6e4);
    }
    function getParametersValue(parameters, name, defaultValue) {
      var _a;
      if (parameters instanceof Object === false) {
        return defaultValue;
      }
      return (_a = parameters[name]) !== null && _a !== void 0 ? _a : defaultValue;
    }
    function bufferToHexCodes(inputBuffer, inputOffset = 0, inputLength = inputBuffer.byteLength - inputOffset, insertSpace = false) {
      let result = "";
      for (const item of new Uint8Array(inputBuffer, inputOffset, inputLength)) {
        const str = item.toString(16).toUpperCase();
        if (str.length === 1) {
          result += "0";
        }
        result += str;
        if (insertSpace) {
          result += " ";
        }
      }
      return result.trim();
    }
    function checkBufferParams(baseBlock, inputBuffer, inputOffset, inputLength) {
      if (!(inputBuffer instanceof ArrayBuffer)) {
        baseBlock.error = 'Wrong parameter: inputBuffer must be "ArrayBuffer"';
        return false;
      }
      if (!inputBuffer.byteLength) {
        baseBlock.error = "Wrong parameter: inputBuffer has zero length";
        return false;
      }
      if (inputOffset < 0) {
        baseBlock.error = "Wrong parameter: inputOffset less than zero";
        return false;
      }
      if (inputLength < 0) {
        baseBlock.error = "Wrong parameter: inputLength less than zero";
        return false;
      }
      if (inputBuffer.byteLength - inputOffset - inputLength < 0) {
        baseBlock.error = "End of input reached before message was fully decoded (inconsistent offset and length values)";
        return false;
      }
      return true;
    }
    function utilFromBase(inputBuffer, inputBase) {
      let result = 0;
      if (inputBuffer.length === 1) {
        return inputBuffer[0];
      }
      for (let i = inputBuffer.length - 1; i >= 0; i--) {
        result += inputBuffer[inputBuffer.length - 1 - i] * Math.pow(2, inputBase * i);
      }
      return result;
    }
    function utilToBase(value, base, reserved = -1) {
      const internalReserved = reserved;
      let internalValue = value;
      let result = 0;
      let biggest = Math.pow(2, base);
      for (let i = 1; i < 8; i++) {
        if (value < biggest) {
          let retBuf;
          if (internalReserved < 0) {
            retBuf = new ArrayBuffer(i);
            result = i;
          } else {
            if (internalReserved < i) {
              return new ArrayBuffer(0);
            }
            retBuf = new ArrayBuffer(internalReserved);
            result = internalReserved;
          }
          const retView = new Uint8Array(retBuf);
          for (let j = i - 1; j >= 0; j--) {
            const basis = Math.pow(2, j * base);
            retView[result - j - 1] = Math.floor(internalValue / basis);
            internalValue -= retView[result - j - 1] * basis;
          }
          return retBuf;
        }
        biggest *= Math.pow(2, base);
      }
      return new ArrayBuffer(0);
    }
    function utilConcatBuf(...buffers) {
      let outputLength = 0;
      let prevLength = 0;
      for (const buffer of buffers) {
        outputLength += buffer.byteLength;
      }
      const retBuf = new ArrayBuffer(outputLength);
      const retView = new Uint8Array(retBuf);
      for (const buffer of buffers) {
        retView.set(new Uint8Array(buffer), prevLength);
        prevLength += buffer.byteLength;
      }
      return retBuf;
    }
    function utilConcatView(...views) {
      let outputLength = 0;
      let prevLength = 0;
      for (const view of views) {
        outputLength += view.length;
      }
      const retBuf = new ArrayBuffer(outputLength);
      const retView = new Uint8Array(retBuf);
      for (const view of views) {
        retView.set(view, prevLength);
        prevLength += view.length;
      }
      return retView;
    }
    function utilDecodeTC() {
      const buf = new Uint8Array(this.valueHex);
      if (this.valueHex.byteLength >= 2) {
        const condition1 = buf[0] === 255 && buf[1] & 128;
        const condition2 = buf[0] === 0 && (buf[1] & 128) === 0;
        if (condition1 || condition2) {
          this.warnings.push("Needlessly long format");
        }
      }
      const bigIntBuffer = new ArrayBuffer(this.valueHex.byteLength);
      const bigIntView = new Uint8Array(bigIntBuffer);
      for (let i = 0; i < this.valueHex.byteLength; i++) {
        bigIntView[i] = 0;
      }
      bigIntView[0] = buf[0] & 128;
      const bigInt = utilFromBase(bigIntView, 8);
      const smallIntBuffer = new ArrayBuffer(this.valueHex.byteLength);
      const smallIntView = new Uint8Array(smallIntBuffer);
      for (let j = 0; j < this.valueHex.byteLength; j++) {
        smallIntView[j] = buf[j];
      }
      smallIntView[0] &= 127;
      const smallInt = utilFromBase(smallIntView, 8);
      return smallInt - bigInt;
    }
    function utilEncodeTC(value) {
      const modValue = value < 0 ? value * -1 : value;
      let bigInt = 128;
      for (let i = 1; i < 8; i++) {
        if (modValue <= bigInt) {
          if (value < 0) {
            const smallInt = bigInt - modValue;
            const retBuf2 = utilToBase(smallInt, 8, i);
            const retView2 = new Uint8Array(retBuf2);
            retView2[0] |= 128;
            return retBuf2;
          }
          let retBuf = utilToBase(modValue, 8, i);
          let retView = new Uint8Array(retBuf);
          if (retView[0] & 128) {
            const tempBuf = retBuf.slice(0);
            const tempView = new Uint8Array(tempBuf);
            retBuf = new ArrayBuffer(retBuf.byteLength + 1);
            retView = new Uint8Array(retBuf);
            for (let k = 0; k < tempBuf.byteLength; k++) {
              retView[k + 1] = tempView[k];
            }
            retView[0] = 0;
          }
          return retBuf;
        }
        bigInt *= Math.pow(2, 8);
      }
      return new ArrayBuffer(0);
    }
    function isEqualBuffer(inputBuffer1, inputBuffer2) {
      if (inputBuffer1.byteLength !== inputBuffer2.byteLength) {
        return false;
      }
      const view1 = new Uint8Array(inputBuffer1);
      const view2 = new Uint8Array(inputBuffer2);
      for (let i = 0; i < view1.length; i++) {
        if (view1[i] !== view2[i]) {
          return false;
        }
      }
      return true;
    }
    function padNumber(inputNumber, fullLength) {
      const str = inputNumber.toString(10);
      if (fullLength < str.length) {
        return "";
      }
      const dif = fullLength - str.length;
      const padding = Array.from({ length: dif });
      for (let i = 0; i < dif; i++) {
        padding[i] = "0";
      }
      const paddingString = padding.join("");
      return paddingString.concat(str);
    }
    var base64Template = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=";
    var base64UrlTemplate = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_=";
    function toBase64(input, useUrlTemplate = false, skipPadding = false, skipLeadingZeros = false) {
      let i = 0;
      let flag1 = 0;
      let flag2 = 0;
      let output = "";
      const template = useUrlTemplate ? base64UrlTemplate : base64Template;
      if (skipLeadingZeros) {
        let nonZeroPosition = 0;
        for (let i2 = 0; i2 < input.length; i2++) {
          if (input.charCodeAt(i2) !== 0) {
            nonZeroPosition = i2;
            break;
          }
        }
        input = input.slice(nonZeroPosition);
      }
      while (i < input.length) {
        const chr1 = input.charCodeAt(i++);
        if (i >= input.length) {
          flag1 = 1;
        }
        const chr2 = input.charCodeAt(i++);
        if (i >= input.length) {
          flag2 = 1;
        }
        const chr3 = input.charCodeAt(i++);
        const enc1 = chr1 >> 2;
        const enc2 = (chr1 & 3) << 4 | chr2 >> 4;
        let enc3 = (chr2 & 15) << 2 | chr3 >> 6;
        let enc4 = chr3 & 63;
        if (flag1 === 1) {
          enc3 = enc4 = 64;
        } else {
          if (flag2 === 1) {
            enc4 = 64;
          }
        }
        if (skipPadding) {
          if (enc3 === 64) {
            output += `${template.charAt(enc1)}${template.charAt(enc2)}`;
          } else {
            if (enc4 === 64) {
              output += `${template.charAt(enc1)}${template.charAt(enc2)}${template.charAt(enc3)}`;
            } else {
              output += `${template.charAt(enc1)}${template.charAt(enc2)}${template.charAt(enc3)}${template.charAt(enc4)}`;
            }
          }
        } else {
          output += `${template.charAt(enc1)}${template.charAt(enc2)}${template.charAt(enc3)}${template.charAt(enc4)}`;
        }
      }
      return output;
    }
    function fromBase64(input, useUrlTemplate = false, cutTailZeros = false) {
      const template = useUrlTemplate ? base64UrlTemplate : base64Template;
      function indexOf(toSearch) {
        for (let i2 = 0; i2 < 64; i2++) {
          if (template.charAt(i2) === toSearch)
            return i2;
        }
        return 64;
      }
      function test(incoming) {
        return incoming === 64 ? 0 : incoming;
      }
      let i = 0;
      let output = "";
      while (i < input.length) {
        const enc1 = indexOf(input.charAt(i++));
        const enc2 = i >= input.length ? 0 : indexOf(input.charAt(i++));
        const enc3 = i >= input.length ? 0 : indexOf(input.charAt(i++));
        const enc4 = i >= input.length ? 0 : indexOf(input.charAt(i++));
        const chr1 = test(enc1) << 2 | test(enc2) >> 4;
        const chr2 = (test(enc2) & 15) << 4 | test(enc3) >> 2;
        const chr3 = (test(enc3) & 3) << 6 | test(enc4);
        output += String.fromCharCode(chr1);
        if (enc3 !== 64) {
          output += String.fromCharCode(chr2);
        }
        if (enc4 !== 64) {
          output += String.fromCharCode(chr3);
        }
      }
      if (cutTailZeros) {
        const outputLength = output.length;
        let nonZeroStart = -1;
        for (let i2 = outputLength - 1; i2 >= 0; i2--) {
          if (output.charCodeAt(i2) !== 0) {
            nonZeroStart = i2;
            break;
          }
        }
        if (nonZeroStart !== -1) {
          output = output.slice(0, nonZeroStart + 1);
        } else {
          output = "";
        }
      }
      return output;
    }
    function arrayBufferToString(buffer) {
      let resultString = "";
      const view = new Uint8Array(buffer);
      for (const element of view) {
        resultString += String.fromCharCode(element);
      }
      return resultString;
    }
    function stringToArrayBuffer(str) {
      const stringLength = str.length;
      const resultBuffer = new ArrayBuffer(stringLength);
      const resultView = new Uint8Array(resultBuffer);
      for (let i = 0; i < stringLength; i++) {
        resultView[i] = str.charCodeAt(i);
      }
      return resultBuffer;
    }
    var log2 = Math.log(2);
    function nearestPowerOf2(length) {
      const base = Math.log(length) / log2;
      const floor = Math.floor(base);
      const round = Math.round(base);
      return floor === round ? floor : round;
    }
    function clearProps(object, propsArray) {
      for (const prop of propsArray) {
        delete object[prop];
      }
    }
    exports.arrayBufferToString = arrayBufferToString;
    exports.bufferToHexCodes = bufferToHexCodes;
    exports.checkBufferParams = checkBufferParams;
    exports.clearProps = clearProps;
    exports.fromBase64 = fromBase64;
    exports.getParametersValue = getParametersValue;
    exports.getUTCDate = getUTCDate;
    exports.isEqualBuffer = isEqualBuffer;
    exports.nearestPowerOf2 = nearestPowerOf2;
    exports.padNumber = padNumber;
    exports.stringToArrayBuffer = stringToArrayBuffer;
    exports.toBase64 = toBase64;
    exports.utilConcatBuf = utilConcatBuf;
    exports.utilConcatView = utilConcatView;
    exports.utilDecodeTC = utilDecodeTC;
    exports.utilEncodeTC = utilEncodeTC;
    exports.utilFromBase = utilFromBase;
    exports.utilToBase = utilToBase;
  }
});

// node_modules/asn1js/build/index.js
var require_build2 = __commonJS({
  "node_modules/asn1js/build/index.js"(exports) {
    "use strict";
    var pvtsutils = require_build();
    var pvutils = require_utils();
    function _interopNamespaceDefault(e) {
      var n = /* @__PURE__ */ Object.create(null);
      if (e) {
        Object.keys(e).forEach(function(k) {
          if (k !== "default") {
            var d = Object.getOwnPropertyDescriptor(e, k);
            Object.defineProperty(n, k, d.get ? d : {
              enumerable: true,
              get: function() {
                return e[k];
              }
            });
          }
        });
      }
      n.default = e;
      return Object.freeze(n);
    }
    var pvtsutils__namespace = /* @__PURE__ */ _interopNamespaceDefault(pvtsutils);
    var pvutils__namespace = /* @__PURE__ */ _interopNamespaceDefault(pvutils);
    function assertBigInt() {
      if (typeof BigInt === "undefined") {
        throw new Error("BigInt is not defined. Your environment doesn't implement BigInt.");
      }
    }
    function concat(buffers) {
      let outputLength = 0;
      let prevLength = 0;
      for (let i = 0; i < buffers.length; i++) {
        const buffer = buffers[i];
        outputLength += buffer.byteLength;
      }
      const retView = new Uint8Array(outputLength);
      for (let i = 0; i < buffers.length; i++) {
        const buffer = buffers[i];
        retView.set(new Uint8Array(buffer), prevLength);
        prevLength += buffer.byteLength;
      }
      return retView.buffer;
    }
    function checkBufferParams(baseBlock, inputBuffer, inputOffset, inputLength) {
      if (!(inputBuffer instanceof Uint8Array)) {
        baseBlock.error = "Wrong parameter: inputBuffer must be 'Uint8Array'";
        return false;
      }
      if (!inputBuffer.byteLength) {
        baseBlock.error = "Wrong parameter: inputBuffer has zero length";
        return false;
      }
      if (inputOffset < 0) {
        baseBlock.error = "Wrong parameter: inputOffset less than zero";
        return false;
      }
      if (inputLength < 0) {
        baseBlock.error = "Wrong parameter: inputLength less than zero";
        return false;
      }
      if (inputBuffer.byteLength - inputOffset - inputLength < 0) {
        baseBlock.error = "End of input reached before message was fully decoded (inconsistent offset and length values)";
        return false;
      }
      return true;
    }
    var ViewWriter = class {
      constructor() {
        this.items = [];
      }
      write(buf) {
        this.items.push(buf);
      }
      final() {
        return concat(this.items);
      }
    };
    var powers2 = [new Uint8Array([1])];
    var digitsString = "0123456789";
    var NAME = "name";
    var VALUE_HEX_VIEW = "valueHexView";
    var IS_HEX_ONLY = "isHexOnly";
    var ID_BLOCK = "idBlock";
    var TAG_CLASS = "tagClass";
    var TAG_NUMBER = "tagNumber";
    var IS_CONSTRUCTED = "isConstructed";
    var FROM_BER = "fromBER";
    var TO_BER = "toBER";
    var LOCAL = "local";
    var EMPTY_STRING = "";
    var EMPTY_BUFFER = new ArrayBuffer(0);
    var EMPTY_VIEW = new Uint8Array(0);
    var END_OF_CONTENT_NAME = "EndOfContent";
    var OCTET_STRING_NAME = "OCTET STRING";
    var BIT_STRING_NAME = "BIT STRING";
    function HexBlock(BaseClass) {
      var _a2;
      return _a2 = class Some extends BaseClass {
        get valueHex() {
          return this.valueHexView.slice().buffer;
        }
        set valueHex(value) {
          this.valueHexView = new Uint8Array(value);
        }
        constructor(...args) {
          var _b;
          super(...args);
          const params = args[0] || {};
          this.isHexOnly = (_b = params.isHexOnly) !== null && _b !== void 0 ? _b : false;
          this.valueHexView = params.valueHex ? pvtsutils__namespace.BufferSourceConverter.toUint8Array(params.valueHex) : EMPTY_VIEW;
        }
        fromBER(inputBuffer, inputOffset, inputLength, _context) {
          const view = inputBuffer instanceof ArrayBuffer ? new Uint8Array(inputBuffer) : inputBuffer;
          if (!checkBufferParams(this, view, inputOffset, inputLength)) {
            return -1;
          }
          const endLength = inputOffset + inputLength;
          this.valueHexView = view.subarray(inputOffset, endLength);
          if (!this.valueHexView.length) {
            this.warnings.push("Zero buffer length");
            return inputOffset;
          }
          this.blockLength = inputLength;
          return endLength;
        }
        toBER(sizeOnly = false) {
          if (!this.isHexOnly) {
            this.error = "Flag 'isHexOnly' is not set, abort";
            return EMPTY_BUFFER;
          }
          if (sizeOnly) {
            return new ArrayBuffer(this.valueHexView.byteLength);
          }
          return this.valueHexView.byteLength === this.valueHexView.buffer.byteLength ? this.valueHexView.buffer : this.valueHexView.slice().buffer;
        }
        toJSON() {
          return {
            ...super.toJSON(),
            isHexOnly: this.isHexOnly,
            valueHex: pvtsutils__namespace.Convert.ToHex(this.valueHexView)
          };
        }
      }, _a2.NAME = "hexBlock", _a2;
    }
    var LocalBaseBlock = class {
      static blockName() {
        return this.NAME;
      }
      get valueBeforeDecode() {
        return this.valueBeforeDecodeView.slice().buffer;
      }
      set valueBeforeDecode(value) {
        this.valueBeforeDecodeView = new Uint8Array(value);
      }
      constructor({ blockLength = 0, error = EMPTY_STRING, warnings = [], valueBeforeDecode = EMPTY_VIEW } = {}) {
        this.blockLength = blockLength;
        this.error = error;
        this.warnings = warnings;
        this.valueBeforeDecodeView = pvtsutils__namespace.BufferSourceConverter.toUint8Array(valueBeforeDecode);
      }
      toJSON() {
        return {
          blockName: this.constructor.NAME,
          blockLength: this.blockLength,
          error: this.error,
          warnings: this.warnings,
          valueBeforeDecode: pvtsutils__namespace.Convert.ToHex(this.valueBeforeDecodeView)
        };
      }
    };
    LocalBaseBlock.NAME = "baseBlock";
    var ValueBlock = class extends LocalBaseBlock {
      fromBER(_inputBuffer, _inputOffset, _inputLength, _context) {
        throw TypeError("User need to make a specific function in a class which extends 'ValueBlock'");
      }
      toBER(_sizeOnly, _writer) {
        throw TypeError("User need to make a specific function in a class which extends 'ValueBlock'");
      }
    };
    ValueBlock.NAME = "valueBlock";
    var LocalIdentificationBlock = class extends HexBlock(LocalBaseBlock) {
      constructor({ idBlock = {} } = {}) {
        var _a2, _b, _c, _d;
        super();
        if (idBlock) {
          this.isHexOnly = (_a2 = idBlock.isHexOnly) !== null && _a2 !== void 0 ? _a2 : false;
          this.valueHexView = idBlock.valueHex ? pvtsutils__namespace.BufferSourceConverter.toUint8Array(idBlock.valueHex) : EMPTY_VIEW;
          this.tagClass = (_b = idBlock.tagClass) !== null && _b !== void 0 ? _b : -1;
          this.tagNumber = (_c = idBlock.tagNumber) !== null && _c !== void 0 ? _c : -1;
          this.isConstructed = (_d = idBlock.isConstructed) !== null && _d !== void 0 ? _d : false;
        } else {
          this.tagClass = -1;
          this.tagNumber = -1;
          this.isConstructed = false;
        }
      }
      toBER(sizeOnly = false) {
        let firstOctet = 0;
        switch (this.tagClass) {
          case 1:
            firstOctet |= 0;
            break;
          case 2:
            firstOctet |= 64;
            break;
          case 3:
            firstOctet |= 128;
            break;
          case 4:
            firstOctet |= 192;
            break;
          default:
            this.error = "Unknown tag class";
            return EMPTY_BUFFER;
        }
        if (this.isConstructed)
          firstOctet |= 32;
        if (this.tagNumber < 31 && !this.isHexOnly) {
          const retView2 = new Uint8Array(1);
          if (!sizeOnly) {
            let number = this.tagNumber;
            number &= 31;
            firstOctet |= number;
            retView2[0] = firstOctet;
          }
          return retView2.buffer;
        }
        if (!this.isHexOnly) {
          const encodedBuf = pvutils__namespace.utilToBase(this.tagNumber, 7);
          const encodedView = new Uint8Array(encodedBuf);
          const size = encodedBuf.byteLength;
          const retView2 = new Uint8Array(size + 1);
          retView2[0] = firstOctet | 31;
          if (!sizeOnly) {
            for (let i = 0; i < size - 1; i++)
              retView2[i + 1] = encodedView[i] | 128;
            retView2[size] = encodedView[size - 1];
          }
          return retView2.buffer;
        }
        const retView = new Uint8Array(this.valueHexView.byteLength + 1);
        retView[0] = firstOctet | 31;
        if (!sizeOnly) {
          const curView = this.valueHexView;
          for (let i = 0; i < curView.length - 1; i++)
            retView[i + 1] = curView[i] | 128;
          retView[this.valueHexView.byteLength] = curView[curView.length - 1];
        }
        return retView.buffer;
      }
      fromBER(inputBuffer, inputOffset, inputLength) {
        const inputView = pvtsutils__namespace.BufferSourceConverter.toUint8Array(inputBuffer);
        if (!checkBufferParams(this, inputView, inputOffset, inputLength)) {
          return -1;
        }
        const intBuffer = inputView.subarray(inputOffset, inputOffset + inputLength);
        if (intBuffer.length === 0) {
          this.error = "Zero buffer length";
          return -1;
        }
        const tagClassMask = intBuffer[0] & 192;
        switch (tagClassMask) {
          case 0:
            this.tagClass = 1;
            break;
          case 64:
            this.tagClass = 2;
            break;
          case 128:
            this.tagClass = 3;
            break;
          case 192:
            this.tagClass = 4;
            break;
          default:
            this.error = "Unknown tag class";
            return -1;
        }
        this.isConstructed = (intBuffer[0] & 32) === 32;
        this.isHexOnly = false;
        const tagNumberMask = intBuffer[0] & 31;
        if (tagNumberMask !== 31) {
          this.tagNumber = tagNumberMask;
          this.blockLength = 1;
        } else {
          let count = 0;
          while (true) {
            const tagByteIndex = count + 1;
            if (tagByteIndex >= intBuffer.length) {
              this.error = "End of input reached before message was fully decoded";
              return -1;
            }
            count++;
            if ((intBuffer[tagByteIndex] & 128) === 0)
              break;
          }
          this.blockLength = count + 1;
          const intTagNumberBuffer = this.valueHexView = new Uint8Array(count);
          for (let i = 0; i < count; i++)
            intTagNumberBuffer[i] = intBuffer[i + 1] & 127;
          if (this.blockLength <= 9)
            this.tagNumber = pvutils__namespace.utilFromBase(intTagNumberBuffer, 7);
          else {
            this.isHexOnly = true;
            this.warnings.push("Tag too long, represented as hex-coded");
          }
        }
        if (this.tagClass === 1 && this.isConstructed) {
          switch (this.tagNumber) {
            case 1:
            case 2:
            case 5:
            case 6:
            case 9:
            case 13:
            case 14:
            case 23:
            case 24:
            case 31:
            case 32:
            case 33:
            case 34:
              this.error = "Constructed encoding used for primitive type";
              return -1;
          }
        }
        return inputOffset + this.blockLength;
      }
      toJSON() {
        return {
          ...super.toJSON(),
          tagClass: this.tagClass,
          tagNumber: this.tagNumber,
          isConstructed: this.isConstructed
        };
      }
    };
    LocalIdentificationBlock.NAME = "identificationBlock";
    var LocalLengthBlock = class extends LocalBaseBlock {
      constructor({ lenBlock = {} } = {}) {
        var _a2, _b, _c;
        super();
        this.isIndefiniteForm = (_a2 = lenBlock.isIndefiniteForm) !== null && _a2 !== void 0 ? _a2 : false;
        this.longFormUsed = (_b = lenBlock.longFormUsed) !== null && _b !== void 0 ? _b : false;
        this.length = (_c = lenBlock.length) !== null && _c !== void 0 ? _c : 0;
      }
      fromBER(inputBuffer, inputOffset, inputLength) {
        const view = pvtsutils__namespace.BufferSourceConverter.toUint8Array(inputBuffer);
        if (!checkBufferParams(this, view, inputOffset, inputLength)) {
          return -1;
        }
        const intBuffer = view.subarray(inputOffset, inputOffset + inputLength);
        if (intBuffer.length === 0) {
          this.error = "Zero buffer length";
          return -1;
        }
        if (intBuffer[0] === 255) {
          this.error = "Length block 0xFF is reserved by standard";
          return -1;
        }
        this.isIndefiniteForm = intBuffer[0] === 128;
        if (this.isIndefiniteForm) {
          this.blockLength = 1;
          return inputOffset + this.blockLength;
        }
        this.longFormUsed = !!(intBuffer[0] & 128);
        if (this.longFormUsed === false) {
          this.length = intBuffer[0];
          this.blockLength = 1;
          return inputOffset + this.blockLength;
        }
        const count = intBuffer[0] & 127;
        if (count > 8) {
          this.error = "Too big integer";
          return -1;
        }
        if (count + 1 > intBuffer.length) {
          this.error = "End of input reached before message was fully decoded";
          return -1;
        }
        const lenOffset = inputOffset + 1;
        const lengthBufferView = view.subarray(lenOffset, lenOffset + count);
        if (lengthBufferView[count - 1] === 0)
          this.warnings.push("Needlessly long encoded length");
        this.length = pvutils__namespace.utilFromBase(lengthBufferView, 8);
        if (this.longFormUsed && this.length <= 127)
          this.warnings.push("Unnecessary usage of long length form");
        this.blockLength = count + 1;
        return inputOffset + this.blockLength;
      }
      toBER(sizeOnly = false) {
        let retBuf;
        let retView;
        if (this.length > 127)
          this.longFormUsed = true;
        if (this.isIndefiniteForm) {
          retBuf = new ArrayBuffer(1);
          if (sizeOnly === false) {
            retView = new Uint8Array(retBuf);
            retView[0] = 128;
          }
          return retBuf;
        }
        if (this.longFormUsed) {
          const encodedBuf = pvutils__namespace.utilToBase(this.length, 8);
          if (encodedBuf.byteLength > 127) {
            this.error = "Too big length";
            return EMPTY_BUFFER;
          }
          retBuf = new ArrayBuffer(encodedBuf.byteLength + 1);
          if (sizeOnly)
            return retBuf;
          const encodedView = new Uint8Array(encodedBuf);
          retView = new Uint8Array(retBuf);
          retView[0] = encodedBuf.byteLength | 128;
          for (let i = 0; i < encodedBuf.byteLength; i++)
            retView[i + 1] = encodedView[i];
          return retBuf;
        }
        retBuf = new ArrayBuffer(1);
        if (sizeOnly === false) {
          retView = new Uint8Array(retBuf);
          retView[0] = this.length;
        }
        return retBuf;
      }
      toJSON() {
        return {
          ...super.toJSON(),
          isIndefiniteForm: this.isIndefiniteForm,
          longFormUsed: this.longFormUsed,
          length: this.length
        };
      }
    };
    LocalLengthBlock.NAME = "lengthBlock";
    var typeStore = {};
    var BaseBlock = class extends LocalBaseBlock {
      constructor({ name = EMPTY_STRING, optional = false, primitiveSchema, ...parameters } = {}, valueBlockType) {
        super(parameters);
        this.name = name;
        this.optional = optional;
        if (primitiveSchema) {
          this.primitiveSchema = primitiveSchema;
        }
        this.idBlock = new LocalIdentificationBlock(parameters);
        this.lenBlock = new LocalLengthBlock(parameters);
        this.valueBlock = valueBlockType ? new valueBlockType(parameters) : new ValueBlock(parameters);
      }
      fromBER(inputBuffer, inputOffset, inputLength, context) {
        const resultOffset = this.valueBlock.fromBER(inputBuffer, inputOffset, this.lenBlock.isIndefiniteForm ? inputLength : this.lenBlock.length, context);
        if (resultOffset === -1) {
          this.error = this.valueBlock.error;
          return resultOffset;
        }
        if (!this.idBlock.error.length)
          this.blockLength += this.idBlock.blockLength;
        if (!this.lenBlock.error.length)
          this.blockLength += this.lenBlock.blockLength;
        if (!this.valueBlock.error.length)
          this.blockLength += this.valueBlock.blockLength;
        return resultOffset;
      }
      toBER(sizeOnly, writer) {
        const _writer = writer || new ViewWriter();
        if (!writer) {
          prepareIndefiniteForm(this);
        }
        const idBlockBuf = this.idBlock.toBER(sizeOnly);
        _writer.write(idBlockBuf);
        if (this.lenBlock.isIndefiniteForm) {
          _writer.write(new Uint8Array([128]).buffer);
          this.valueBlock.toBER(sizeOnly, _writer);
          _writer.write(new ArrayBuffer(2));
        } else {
          const valueBlockBuf = this.valueBlock.toBER(sizeOnly);
          this.lenBlock.length = valueBlockBuf.byteLength;
          const lenBlockBuf = this.lenBlock.toBER(sizeOnly);
          _writer.write(lenBlockBuf);
          _writer.write(valueBlockBuf);
        }
        if (!writer) {
          return _writer.final();
        }
        return EMPTY_BUFFER;
      }
      toJSON() {
        const object = {
          ...super.toJSON(),
          idBlock: this.idBlock.toJSON(),
          lenBlock: this.lenBlock.toJSON(),
          valueBlock: this.valueBlock.toJSON(),
          name: this.name,
          optional: this.optional
        };
        if (this.primitiveSchema)
          object.primitiveSchema = this.primitiveSchema.toJSON();
        return object;
      }
      toString(encoding = "ascii") {
        if (encoding === "ascii") {
          return this.onAsciiEncoding();
        }
        return pvtsutils__namespace.Convert.ToHex(this.toBER());
      }
      onAsciiEncoding() {
        const name = this.constructor.NAME;
        const value = pvtsutils__namespace.Convert.ToHex(this.valueBlock.valueBeforeDecodeView);
        return `${name} : ${value}`;
      }
      isEqual(other) {
        if (this === other) {
          return true;
        }
        if (!(other instanceof this.constructor)) {
          return false;
        }
        const thisRaw = this.toBER();
        const otherRaw = other.toBER();
        return pvutils__namespace.isEqualBuffer(thisRaw, otherRaw);
      }
    };
    BaseBlock.NAME = "BaseBlock";
    function prepareIndefiniteForm(baseBlock) {
      var _a2;
      if (baseBlock instanceof typeStore.Constructed) {
        for (const value of baseBlock.valueBlock.value) {
          if (prepareIndefiniteForm(value)) {
            baseBlock.lenBlock.isIndefiniteForm = true;
          }
        }
      }
      return !!((_a2 = baseBlock.lenBlock) === null || _a2 === void 0 ? void 0 : _a2.isIndefiniteForm);
    }
    var BaseStringBlock = class extends BaseBlock {
      getValue() {
        return this.valueBlock.value;
      }
      setValue(value) {
        this.valueBlock.value = value;
      }
      constructor({ value = EMPTY_STRING, ...parameters } = {}, stringValueBlockType) {
        super(parameters, stringValueBlockType);
        if (value) {
          this.fromString(value);
        }
      }
      fromBER(inputBuffer, inputOffset, inputLength) {
        const resultOffset = this.valueBlock.fromBER(inputBuffer, inputOffset, this.lenBlock.isIndefiniteForm ? inputLength : this.lenBlock.length);
        if (resultOffset === -1) {
          this.error = this.valueBlock.error;
          return resultOffset;
        }
        this.fromBuffer(this.valueBlock.valueHexView);
        if (!this.idBlock.error.length)
          this.blockLength += this.idBlock.blockLength;
        if (!this.lenBlock.error.length)
          this.blockLength += this.lenBlock.blockLength;
        if (!this.valueBlock.error.length)
          this.blockLength += this.valueBlock.blockLength;
        return resultOffset;
      }
      onAsciiEncoding() {
        return `${this.constructor.NAME} : '${this.valueBlock.value}'`;
      }
    };
    BaseStringBlock.NAME = "BaseStringBlock";
    var LocalPrimitiveValueBlock = class extends HexBlock(ValueBlock) {
      constructor({ isHexOnly = true, ...parameters } = {}) {
        super(parameters);
        this.isHexOnly = isHexOnly;
      }
    };
    LocalPrimitiveValueBlock.NAME = "PrimitiveValueBlock";
    var _a$w;
    var Primitive = class extends BaseBlock {
      constructor(parameters = {}) {
        super(parameters, LocalPrimitiveValueBlock);
        this.idBlock.isConstructed = false;
      }
    };
    _a$w = Primitive;
    (() => {
      typeStore.Primitive = _a$w;
    })();
    Primitive.NAME = "PRIMITIVE";
    var DEFAULT_MAX_DEPTH = 100;
    var DEFAULT_MAX_NODES = 1e4;
    var DEFAULT_MAX_CONTENT_LENGTH = 16 * 1024 * 1024;
    var MAX_DEPTH_EXCEEDED_ERROR = "Maximum ASN.1 nesting depth exceeded";
    var MAX_NODES_EXCEEDED_ERROR = "Maximum ASN.1 node count exceeded";
    var MAX_CONTENT_LENGTH_EXCEEDED_ERROR = "Maximum ASN.1 content length exceeded";
    function createFromBerContext(options = {}) {
      var _a2, _b, _c;
      return {
        depth: 0,
        maxDepth: (_a2 = options.maxDepth) !== null && _a2 !== void 0 ? _a2 : DEFAULT_MAX_DEPTH,
        nodesCount: 0,
        maxNodes: (_b = options.maxNodes) !== null && _b !== void 0 ? _b : DEFAULT_MAX_NODES,
        maxContentLength: (_c = options.maxContentLength) !== null && _c !== void 0 ? _c : DEFAULT_MAX_CONTENT_LENGTH
      };
    }
    function createErrorResult(error) {
      const result = new BaseBlock({}, ValueBlock);
      result.error = error;
      return {
        offset: -1,
        result
      };
    }
    function checkNodesLimit(context) {
      context.nodesCount += 1;
      if (context.nodesCount > context.maxNodes) {
        return MAX_NODES_EXCEEDED_ERROR;
      }
      return void 0;
    }
    function checkContentLengthLimit(inputLength, context) {
      if (inputLength > context.maxContentLength) {
        return MAX_CONTENT_LENGTH_EXCEEDED_ERROR;
      }
      return void 0;
    }
    function localFromBERWithChildContext(inputBuffer, inputOffset, inputLength, context) {
      const childDepth = context.depth + 1;
      if (childDepth > context.maxDepth) {
        return createErrorResult(MAX_DEPTH_EXCEEDED_ERROR);
      }
      context.depth = childDepth;
      try {
        return localFromBER(inputBuffer, inputOffset, inputLength, context);
      } finally {
        context.depth -= 1;
      }
    }
    function localChangeType(inputObject, newType) {
      if (inputObject instanceof newType) {
        return inputObject;
      }
      const newObject = new newType();
      newObject.idBlock = inputObject.idBlock;
      newObject.lenBlock = inputObject.lenBlock;
      newObject.warnings = inputObject.warnings;
      newObject.valueBeforeDecodeView = inputObject.valueBeforeDecodeView;
      return newObject;
    }
    function localFromBER(inputBuffer, inputOffset = 0, inputLength = inputBuffer.length, context = createFromBerContext()) {
      const incomingOffset = inputOffset;
      let returnObject = new BaseBlock({}, ValueBlock);
      const baseBlock = new LocalBaseBlock();
      if (!checkBufferParams(baseBlock, inputBuffer, inputOffset, inputLength)) {
        returnObject.error = baseBlock.error;
        return {
          offset: -1,
          result: returnObject
        };
      }
      const intBuffer = inputBuffer.subarray(inputOffset, inputOffset + inputLength);
      if (!intBuffer.length) {
        returnObject.error = "Zero buffer length";
        return {
          offset: -1,
          result: returnObject
        };
      }
      const nodesLimitError = checkNodesLimit(context);
      if (nodesLimitError) {
        returnObject.error = nodesLimitError;
        return {
          offset: -1,
          result: returnObject
        };
      }
      let resultOffset = returnObject.idBlock.fromBER(inputBuffer, inputOffset, inputLength);
      if (returnObject.idBlock.warnings.length) {
        returnObject.warnings.concat(returnObject.idBlock.warnings);
      }
      if (resultOffset === -1) {
        returnObject.error = returnObject.idBlock.error;
        return {
          offset: -1,
          result: returnObject
        };
      }
      inputOffset = resultOffset;
      inputLength -= returnObject.idBlock.blockLength;
      resultOffset = returnObject.lenBlock.fromBER(inputBuffer, inputOffset, inputLength);
      if (returnObject.lenBlock.warnings.length) {
        returnObject.warnings.concat(returnObject.lenBlock.warnings);
      }
      if (resultOffset === -1) {
        returnObject.error = returnObject.lenBlock.error;
        return {
          offset: -1,
          result: returnObject
        };
      }
      inputOffset = resultOffset;
      inputLength -= returnObject.lenBlock.blockLength;
      const valueLength = returnObject.lenBlock.isIndefiniteForm ? inputLength : returnObject.lenBlock.length;
      const contentLengthError = checkContentLengthLimit(valueLength, context);
      if (contentLengthError) {
        returnObject.error = contentLengthError;
        return {
          offset: -1,
          result: returnObject
        };
      }
      if (!returnObject.idBlock.isConstructed && returnObject.lenBlock.isIndefiniteForm) {
        returnObject.error = "Indefinite length form used for primitive encoding form";
        return {
          offset: -1,
          result: returnObject
        };
      }
      let newASN1Type = BaseBlock;
      switch (returnObject.idBlock.tagClass) {
        case 1:
          if (returnObject.idBlock.tagNumber >= 37 && returnObject.idBlock.isHexOnly === false) {
            returnObject.error = "UNIVERSAL 37 and upper tags are reserved by ASN.1 standard";
            return {
              offset: -1,
              result: returnObject
            };
          }
          switch (returnObject.idBlock.tagNumber) {
            case 0:
              if (returnObject.idBlock.isConstructed && returnObject.lenBlock.length > 0) {
                returnObject.error = "Type [UNIVERSAL 0] is reserved";
                return {
                  offset: -1,
                  result: returnObject
                };
              }
              newASN1Type = typeStore.EndOfContent;
              break;
            case 1:
              newASN1Type = typeStore.Boolean;
              break;
            case 2:
              newASN1Type = typeStore.Integer;
              break;
            case 3:
              newASN1Type = typeStore.BitString;
              break;
            case 4:
              newASN1Type = typeStore.OctetString;
              break;
            case 5:
              newASN1Type = typeStore.Null;
              break;
            case 6:
              newASN1Type = typeStore.ObjectIdentifier;
              break;
            case 10:
              newASN1Type = typeStore.Enumerated;
              break;
            case 12:
              newASN1Type = typeStore.Utf8String;
              break;
            case 13:
              newASN1Type = typeStore.RelativeObjectIdentifier;
              break;
            case 14:
              newASN1Type = typeStore.TIME;
              break;
            case 15:
              returnObject.error = "[UNIVERSAL 15] is reserved by ASN.1 standard";
              return {
                offset: -1,
                result: returnObject
              };
            case 16:
              newASN1Type = typeStore.Sequence;
              break;
            case 17:
              newASN1Type = typeStore.Set;
              break;
            case 18:
              newASN1Type = typeStore.NumericString;
              break;
            case 19:
              newASN1Type = typeStore.PrintableString;
              break;
            case 20:
              newASN1Type = typeStore.TeletexString;
              break;
            case 21:
              newASN1Type = typeStore.VideotexString;
              break;
            case 22:
              newASN1Type = typeStore.IA5String;
              break;
            case 23:
              newASN1Type = typeStore.UTCTime;
              break;
            case 24:
              newASN1Type = typeStore.GeneralizedTime;
              break;
            case 25:
              newASN1Type = typeStore.GraphicString;
              break;
            case 26:
              newASN1Type = typeStore.VisibleString;
              break;
            case 27:
              newASN1Type = typeStore.GeneralString;
              break;
            case 28:
              newASN1Type = typeStore.UniversalString;
              break;
            case 29:
              newASN1Type = typeStore.CharacterString;
              break;
            case 30:
              newASN1Type = typeStore.BmpString;
              break;
            case 31:
              newASN1Type = typeStore.DATE;
              break;
            case 32:
              newASN1Type = typeStore.TimeOfDay;
              break;
            case 33:
              newASN1Type = typeStore.DateTime;
              break;
            case 34:
              newASN1Type = typeStore.Duration;
              break;
            default: {
              const newObject = returnObject.idBlock.isConstructed ? new typeStore.Constructed() : new typeStore.Primitive();
              newObject.idBlock = returnObject.idBlock;
              newObject.lenBlock = returnObject.lenBlock;
              newObject.warnings = returnObject.warnings;
              returnObject = newObject;
            }
          }
          break;
        case 2:
        case 3:
        case 4:
        default: {
          newASN1Type = returnObject.idBlock.isConstructed ? typeStore.Constructed : typeStore.Primitive;
        }
      }
      returnObject = localChangeType(returnObject, newASN1Type);
      resultOffset = returnObject.fromBER(inputBuffer, inputOffset, valueLength, context);
      returnObject.valueBeforeDecodeView = inputBuffer.subarray(incomingOffset, incomingOffset + returnObject.blockLength);
      return {
        offset: resultOffset,
        result: returnObject
      };
    }
    function fromBER(inputBuffer, options = {}) {
      if (!inputBuffer.byteLength) {
        const result = new BaseBlock({}, ValueBlock);
        result.error = "Input buffer has zero length";
        return {
          offset: -1,
          result
        };
      }
      return localFromBER(pvtsutils__namespace.BufferSourceConverter.toUint8Array(inputBuffer).slice(), 0, inputBuffer.byteLength, createFromBerContext(options));
    }
    function checkLen(indefiniteLength, length) {
      if (indefiniteLength) {
        return 1;
      }
      return length;
    }
    var LocalConstructedValueBlock = class extends ValueBlock {
      constructor({ value = [], isIndefiniteForm = false, ...parameters } = {}) {
        super(parameters);
        this.value = value;
        this.isIndefiniteForm = isIndefiniteForm;
      }
      fromBER(inputBuffer, inputOffset, inputLength, context) {
        const view = pvtsutils__namespace.BufferSourceConverter.toUint8Array(inputBuffer);
        const parseContext = context !== null && context !== void 0 ? context : createFromBerContext();
        if (!checkBufferParams(this, view, inputOffset, inputLength)) {
          return -1;
        }
        this.valueBeforeDecodeView = view.subarray(inputOffset, inputOffset + inputLength);
        if (this.valueBeforeDecodeView.length === 0) {
          this.warnings.push("Zero buffer length");
          return inputOffset;
        }
        let currentOffset = inputOffset;
        while (checkLen(this.isIndefiniteForm, inputLength) > 0) {
          const returnObject = localFromBERWithChildContext(view, currentOffset, inputLength, parseContext);
          if (returnObject.offset === -1) {
            this.error = returnObject.result.error;
            this.warnings.concat(returnObject.result.warnings);
            return -1;
          }
          currentOffset = returnObject.offset;
          this.blockLength += returnObject.result.blockLength;
          inputLength -= returnObject.result.blockLength;
          this.value.push(returnObject.result);
          if (this.isIndefiniteForm && returnObject.result.constructor.NAME === END_OF_CONTENT_NAME) {
            break;
          }
        }
        if (this.isIndefiniteForm) {
          if (this.value[this.value.length - 1].constructor.NAME === END_OF_CONTENT_NAME) {
            this.value.pop();
          } else {
            this.warnings.push("No EndOfContent block encoded");
          }
        }
        return currentOffset;
      }
      toBER(sizeOnly, writer) {
        const _writer = writer || new ViewWriter();
        for (let i = 0; i < this.value.length; i++) {
          this.value[i].toBER(sizeOnly, _writer);
        }
        if (!writer) {
          return _writer.final();
        }
        return EMPTY_BUFFER;
      }
      toJSON() {
        const object = {
          ...super.toJSON(),
          isIndefiniteForm: this.isIndefiniteForm,
          value: []
        };
        for (const value of this.value) {
          object.value.push(value.toJSON());
        }
        return object;
      }
    };
    LocalConstructedValueBlock.NAME = "ConstructedValueBlock";
    var _a$v;
    var Constructed = class extends BaseBlock {
      constructor(parameters = {}) {
        super(parameters, LocalConstructedValueBlock);
        this.idBlock.isConstructed = true;
      }
      fromBER(inputBuffer, inputOffset, inputLength, context) {
        this.valueBlock.isIndefiniteForm = this.lenBlock.isIndefiniteForm;
        const resultOffset = this.valueBlock.fromBER(inputBuffer, inputOffset, this.lenBlock.isIndefiniteForm ? inputLength : this.lenBlock.length, context);
        if (resultOffset === -1) {
          this.error = this.valueBlock.error;
          return resultOffset;
        }
        if (!this.idBlock.error.length)
          this.blockLength += this.idBlock.blockLength;
        if (!this.lenBlock.error.length)
          this.blockLength += this.lenBlock.blockLength;
        if (!this.valueBlock.error.length)
          this.blockLength += this.valueBlock.blockLength;
        return resultOffset;
      }
      onAsciiEncoding() {
        const values = [];
        for (const value of this.valueBlock.value) {
          values.push(value.toString("ascii").split("\n").map((o) => `  ${o}`).join("\n"));
        }
        const blockName = this.idBlock.tagClass === 3 ? `[${this.idBlock.tagNumber}]` : this.constructor.NAME;
        return values.length ? `${blockName} :
${values.join("\n")}` : `${blockName} :`;
      }
    };
    _a$v = Constructed;
    (() => {
      typeStore.Constructed = _a$v;
    })();
    Constructed.NAME = "CONSTRUCTED";
    var LocalEndOfContentValueBlock = class extends ValueBlock {
      fromBER(inputBuffer, inputOffset, _inputLength) {
        return inputOffset;
      }
      toBER(_sizeOnly) {
        return EMPTY_BUFFER;
      }
    };
    LocalEndOfContentValueBlock.override = "EndOfContentValueBlock";
    var _a$u;
    var EndOfContent = class extends BaseBlock {
      constructor(parameters = {}) {
        super(parameters, LocalEndOfContentValueBlock);
        this.idBlock.tagClass = 1;
        this.idBlock.tagNumber = 0;
      }
    };
    _a$u = EndOfContent;
    (() => {
      typeStore.EndOfContent = _a$u;
    })();
    EndOfContent.NAME = END_OF_CONTENT_NAME;
    var _a$t;
    var Null = class extends BaseBlock {
      constructor(parameters = {}) {
        super(parameters, ValueBlock);
        this.idBlock.tagClass = 1;
        this.idBlock.tagNumber = 5;
      }
      fromBER(inputBuffer, inputOffset, inputLength) {
        if (this.lenBlock.length > 0)
          this.warnings.push("Non-zero length of value block for Null type");
        if (!this.idBlock.error.length)
          this.blockLength += this.idBlock.blockLength;
        if (!this.lenBlock.error.length)
          this.blockLength += this.lenBlock.blockLength;
        this.blockLength += inputLength;
        if (inputOffset + inputLength > inputBuffer.byteLength) {
          this.error = "End of input reached before message was fully decoded (inconsistent offset and length values)";
          return -1;
        }
        return inputOffset + inputLength;
      }
      toBER(sizeOnly, writer) {
        const retBuf = new ArrayBuffer(2);
        if (!sizeOnly) {
          const retView = new Uint8Array(retBuf);
          retView[0] = 5;
          retView[1] = 0;
        }
        if (writer) {
          writer.write(retBuf);
        }
        return retBuf;
      }
      onAsciiEncoding() {
        return `${this.constructor.NAME}`;
      }
    };
    _a$t = Null;
    (() => {
      typeStore.Null = _a$t;
    })();
    Null.NAME = "NULL";
    var LocalBooleanValueBlock = class extends HexBlock(ValueBlock) {
      get value() {
        for (const octet of this.valueHexView) {
          if (octet > 0) {
            return true;
          }
        }
        return false;
      }
      set value(value) {
        this.valueHexView[0] = value ? 255 : 0;
      }
      constructor({ value, ...parameters } = {}) {
        super(parameters);
        if (parameters.valueHex) {
          this.valueHexView = pvtsutils__namespace.BufferSourceConverter.toUint8Array(parameters.valueHex);
        } else {
          this.valueHexView = new Uint8Array(1);
        }
        if (value) {
          this.value = value;
        }
      }
      fromBER(inputBuffer, inputOffset, inputLength) {
        const inputView = pvtsutils__namespace.BufferSourceConverter.toUint8Array(inputBuffer);
        if (!checkBufferParams(this, inputView, inputOffset, inputLength)) {
          return -1;
        }
        this.valueHexView = inputView.subarray(inputOffset, inputOffset + inputLength);
        if (inputLength > 1)
          this.warnings.push("Boolean value encoded in more then 1 octet");
        this.isHexOnly = true;
        pvutils__namespace.utilDecodeTC.call(this);
        this.blockLength = inputLength;
        return inputOffset + inputLength;
      }
      toBER() {
        return this.valueHexView.slice();
      }
      toJSON() {
        return {
          ...super.toJSON(),
          value: this.value
        };
      }
    };
    LocalBooleanValueBlock.NAME = "BooleanValueBlock";
    var _a$s;
    var Boolean2 = class extends BaseBlock {
      getValue() {
        return this.valueBlock.value;
      }
      setValue(value) {
        this.valueBlock.value = value;
      }
      constructor(parameters = {}) {
        super(parameters, LocalBooleanValueBlock);
        this.idBlock.tagClass = 1;
        this.idBlock.tagNumber = 1;
      }
      onAsciiEncoding() {
        return `${this.constructor.NAME} : ${this.getValue}`;
      }
    };
    _a$s = Boolean2;
    (() => {
      typeStore.Boolean = _a$s;
    })();
    Boolean2.NAME = "BOOLEAN";
    var LocalOctetStringValueBlock = class extends HexBlock(LocalConstructedValueBlock) {
      constructor({ isConstructed = false, ...parameters } = {}) {
        super(parameters);
        this.isConstructed = isConstructed;
      }
      fromBER(inputBuffer, inputOffset, inputLength, context) {
        let resultOffset = 0;
        if (this.isConstructed) {
          this.isHexOnly = false;
          resultOffset = LocalConstructedValueBlock.prototype.fromBER.call(this, inputBuffer, inputOffset, inputLength, context);
          if (resultOffset === -1)
            return resultOffset;
          for (let i = 0; i < this.value.length; i++) {
            const currentBlockName = this.value[i].constructor.NAME;
            if (currentBlockName === END_OF_CONTENT_NAME) {
              if (this.isIndefiniteForm)
                break;
              else {
                this.error = "EndOfContent is unexpected, OCTET STRING may consists of OCTET STRINGs only";
                return -1;
              }
            }
            if (currentBlockName !== OCTET_STRING_NAME) {
              this.error = "OCTET STRING may consists of OCTET STRINGs only";
              return -1;
            }
          }
        } else {
          this.isHexOnly = true;
          resultOffset = super.fromBER(inputBuffer, inputOffset, inputLength);
          this.blockLength = inputLength;
        }
        return resultOffset;
      }
      toBER(sizeOnly, writer) {
        if (this.isConstructed)
          return LocalConstructedValueBlock.prototype.toBER.call(this, sizeOnly, writer);
        return sizeOnly ? new ArrayBuffer(this.valueHexView.byteLength) : this.valueHexView.slice().buffer;
      }
      toJSON() {
        return {
          ...super.toJSON(),
          isConstructed: this.isConstructed
        };
      }
    };
    LocalOctetStringValueBlock.NAME = "OctetStringValueBlock";
    var _a$r;
    var OctetString = class extends BaseBlock {
      constructor({ idBlock = {}, lenBlock = {}, ...parameters } = {}) {
        var _b, _c;
        (_b = parameters.isConstructed) !== null && _b !== void 0 ? _b : parameters.isConstructed = !!((_c = parameters.value) === null || _c === void 0 ? void 0 : _c.length);
        super({
          idBlock: {
            isConstructed: parameters.isConstructed,
            ...idBlock
          },
          lenBlock: {
            ...lenBlock,
            isIndefiniteForm: !!parameters.isIndefiniteForm
          },
          ...parameters
        }, LocalOctetStringValueBlock);
        this.idBlock.tagClass = 1;
        this.idBlock.tagNumber = 4;
      }
      fromBER(inputBuffer, inputOffset, inputLength, context) {
        this.valueBlock.isConstructed = this.idBlock.isConstructed;
        this.valueBlock.isIndefiniteForm = this.lenBlock.isIndefiniteForm;
        if (inputLength === 0) {
          if (this.idBlock.error.length === 0)
            this.blockLength += this.idBlock.blockLength;
          if (this.lenBlock.error.length === 0)
            this.blockLength += this.lenBlock.blockLength;
          return inputOffset;
        }
        if (!this.valueBlock.isConstructed) {
          const view = inputBuffer instanceof ArrayBuffer ? new Uint8Array(inputBuffer) : inputBuffer;
          const buf = view.subarray(inputOffset, inputOffset + inputLength);
          try {
            if (buf.byteLength) {
              const parseContext = context !== null && context !== void 0 ? context : createFromBerContext();
              const asn = localFromBERWithChildContext(buf, 0, buf.byteLength, parseContext);
              if (asn.offset !== -1 && asn.offset === inputLength) {
                this.valueBlock.value = [asn.result];
              }
            }
          } catch {
          }
        }
        return super.fromBER(inputBuffer, inputOffset, inputLength, context);
      }
      onAsciiEncoding() {
        if (this.valueBlock.isConstructed || this.valueBlock.value && this.valueBlock.value.length) {
          return Constructed.prototype.onAsciiEncoding.call(this);
        }
        const name = this.constructor.NAME;
        const value = pvtsutils__namespace.Convert.ToHex(this.valueBlock.valueHexView);
        return `${name} : ${value}`;
      }
      getValue() {
        if (!this.idBlock.isConstructed) {
          return this.valueBlock.valueHexView.slice().buffer;
        }
        const array = [];
        for (const content of this.valueBlock.value) {
          if (content instanceof _a$r) {
            array.push(content.valueBlock.valueHexView);
          }
        }
        return pvtsutils__namespace.BufferSourceConverter.concat(array);
      }
    };
    _a$r = OctetString;
    (() => {
      typeStore.OctetString = _a$r;
    })();
    OctetString.NAME = OCTET_STRING_NAME;
    var LocalBitStringValueBlock = class extends HexBlock(LocalConstructedValueBlock) {
      constructor({ unusedBits = 0, isConstructed = false, ...parameters } = {}) {
        super(parameters);
        this.unusedBits = unusedBits;
        this.isConstructed = isConstructed;
        this.blockLength = this.valueHexView.byteLength;
      }
      fromBER(inputBuffer, inputOffset, inputLength, context) {
        if (!inputLength) {
          return inputOffset;
        }
        let resultOffset = -1;
        if (this.isConstructed) {
          resultOffset = LocalConstructedValueBlock.prototype.fromBER.call(this, inputBuffer, inputOffset, inputLength, context);
          if (resultOffset === -1)
            return resultOffset;
          for (const value of this.value) {
            const currentBlockName = value.constructor.NAME;
            if (currentBlockName === END_OF_CONTENT_NAME) {
              if (this.isIndefiniteForm)
                break;
              else {
                this.error = "EndOfContent is unexpected, BIT STRING may consists of BIT STRINGs only";
                return -1;
              }
            }
            if (currentBlockName !== BIT_STRING_NAME) {
              this.error = "BIT STRING may consists of BIT STRINGs only";
              return -1;
            }
            const valueBlock = value.valueBlock;
            if (this.unusedBits > 0 && valueBlock.unusedBits > 0) {
              this.error = 'Using of "unused bits" inside constructive BIT STRING allowed for least one only';
              return -1;
            }
            this.unusedBits = valueBlock.unusedBits;
          }
          return resultOffset;
        }
        const inputView = pvtsutils__namespace.BufferSourceConverter.toUint8Array(inputBuffer);
        if (!checkBufferParams(this, inputView, inputOffset, inputLength)) {
          return -1;
        }
        const intBuffer = inputView.subarray(inputOffset, inputOffset + inputLength);
        this.unusedBits = intBuffer[0];
        if (this.unusedBits > 7) {
          this.error = "Unused bits for BitString must be in range 0-7";
          return -1;
        }
        if (!this.unusedBits) {
          const buf = intBuffer.subarray(1);
          try {
            if (buf.byteLength) {
              const parseContext = context !== null && context !== void 0 ? context : createFromBerContext();
              const asn = localFromBERWithChildContext(buf, 0, buf.byteLength, parseContext);
              if (asn.offset !== -1 && asn.offset === inputLength - 1) {
                this.value = [asn.result];
              }
            }
          } catch {
          }
        }
        this.valueHexView = intBuffer.subarray(1);
        this.blockLength = intBuffer.length;
        return inputOffset + inputLength;
      }
      toBER(sizeOnly, writer) {
        if (this.isConstructed) {
          return LocalConstructedValueBlock.prototype.toBER.call(this, sizeOnly, writer);
        }
        if (sizeOnly) {
          return new ArrayBuffer(this.valueHexView.byteLength + 1);
        }
        if (!this.valueHexView.byteLength) {
          const empty = new Uint8Array(1);
          empty[0] = 0;
          return empty.buffer;
        }
        const retView = new Uint8Array(this.valueHexView.length + 1);
        retView[0] = this.unusedBits;
        retView.set(this.valueHexView, 1);
        return retView.buffer;
      }
      toJSON() {
        return {
          ...super.toJSON(),
          unusedBits: this.unusedBits,
          isConstructed: this.isConstructed
        };
      }
    };
    LocalBitStringValueBlock.NAME = "BitStringValueBlock";
    var _a$q;
    var BitString = class extends BaseBlock {
      constructor({ idBlock = {}, lenBlock = {}, ...parameters } = {}) {
        var _b, _c;
        (_b = parameters.isConstructed) !== null && _b !== void 0 ? _b : parameters.isConstructed = !!((_c = parameters.value) === null || _c === void 0 ? void 0 : _c.length);
        super({
          idBlock: {
            isConstructed: parameters.isConstructed,
            ...idBlock
          },
          lenBlock: {
            ...lenBlock,
            isIndefiniteForm: !!parameters.isIndefiniteForm
          },
          ...parameters
        }, LocalBitStringValueBlock);
        this.idBlock.tagClass = 1;
        this.idBlock.tagNumber = 3;
      }
      fromBER(inputBuffer, inputOffset, inputLength, context) {
        this.valueBlock.isConstructed = this.idBlock.isConstructed;
        this.valueBlock.isIndefiniteForm = this.lenBlock.isIndefiniteForm;
        return super.fromBER(inputBuffer, inputOffset, inputLength, context);
      }
      onAsciiEncoding() {
        if (this.valueBlock.isConstructed || this.valueBlock.value && this.valueBlock.value.length) {
          return Constructed.prototype.onAsciiEncoding.call(this);
        } else {
          const bits = [];
          const valueHex = this.valueBlock.valueHexView;
          for (const byte of valueHex) {
            bits.push(byte.toString(2).padStart(8, "0"));
          }
          const bitsStr = bits.join("");
          const name = this.constructor.NAME;
          const value = bitsStr.substring(0, bitsStr.length - this.valueBlock.unusedBits);
          return `${name} : ${value}`;
        }
      }
    };
    _a$q = BitString;
    (() => {
      typeStore.BitString = _a$q;
    })();
    BitString.NAME = BIT_STRING_NAME;
    var _a$p;
    function viewAdd(first, second) {
      const c = new Uint8Array([0]);
      const firstView = new Uint8Array(first);
      const secondView = new Uint8Array(second);
      let firstViewCopy = firstView.slice(0);
      const firstViewCopyLength = firstViewCopy.length - 1;
      const secondViewCopy = secondView.slice(0);
      const secondViewCopyLength = secondViewCopy.length - 1;
      let value = 0;
      const max = secondViewCopyLength < firstViewCopyLength ? firstViewCopyLength : secondViewCopyLength;
      let counter = 0;
      for (let i = max; i >= 0; i--, counter++) {
        switch (true) {
          case counter < secondViewCopy.length:
            value = firstViewCopy[firstViewCopyLength - counter] + secondViewCopy[secondViewCopyLength - counter] + c[0];
            break;
          default:
            value = firstViewCopy[firstViewCopyLength - counter] + c[0];
        }
        c[0] = value / 10;
        switch (true) {
          case counter >= firstViewCopy.length:
            firstViewCopy = pvutils__namespace.utilConcatView(new Uint8Array([value % 10]), firstViewCopy);
            break;
          default:
            firstViewCopy[firstViewCopyLength - counter] = value % 10;
        }
      }
      if (c[0] > 0)
        firstViewCopy = pvutils__namespace.utilConcatView(c, firstViewCopy);
      return firstViewCopy;
    }
    function power2(n) {
      if (n >= powers2.length) {
        for (let p = powers2.length; p <= n; p++) {
          const c = new Uint8Array([0]);
          let digits = powers2[p - 1].slice(0);
          for (let i = digits.length - 1; i >= 0; i--) {
            const newValue = new Uint8Array([(digits[i] << 1) + c[0]]);
            c[0] = newValue[0] / 10;
            digits[i] = newValue[0] % 10;
          }
          if (c[0] > 0)
            digits = pvutils__namespace.utilConcatView(c, digits);
          powers2.push(digits);
        }
      }
      return powers2[n];
    }
    function viewSub(first, second) {
      let b = 0;
      const firstView = new Uint8Array(first);
      const secondView = new Uint8Array(second);
      const firstViewCopy = firstView.slice(0);
      const firstViewCopyLength = firstViewCopy.length - 1;
      const secondViewCopy = secondView.slice(0);
      const secondViewCopyLength = secondViewCopy.length - 1;
      let value;
      let counter = 0;
      for (let i = secondViewCopyLength; i >= 0; i--, counter++) {
        value = firstViewCopy[firstViewCopyLength - counter] - secondViewCopy[secondViewCopyLength - counter] - b;
        switch (true) {
          case value < 0:
            b = 1;
            firstViewCopy[firstViewCopyLength - counter] = value + 10;
            break;
          default:
            b = 0;
            firstViewCopy[firstViewCopyLength - counter] = value;
        }
      }
      if (b > 0) {
        for (let i = firstViewCopyLength - secondViewCopyLength + 1; i >= 0; i--, counter++) {
          value = firstViewCopy[firstViewCopyLength - counter] - b;
          if (value < 0) {
            b = 1;
            firstViewCopy[firstViewCopyLength - counter] = value + 10;
          } else {
            b = 0;
            firstViewCopy[firstViewCopyLength - counter] = value;
            break;
          }
        }
      }
      return firstViewCopy.slice();
    }
    var LocalIntegerValueBlock = class extends HexBlock(ValueBlock) {
      setValueHex() {
        if (this.valueHexView.length >= 4) {
          this.warnings.push("Too big Integer for decoding, hex only");
          this.isHexOnly = true;
          this._valueDec = 0;
        } else {
          this.isHexOnly = false;
          if (this.valueHexView.length > 0) {
            this._valueDec = pvutils__namespace.utilDecodeTC.call(this);
          }
        }
      }
      constructor({ value, ...parameters } = {}) {
        super(parameters);
        this._valueDec = 0;
        if (parameters.valueHex) {
          this.setValueHex();
        }
        if (value !== void 0) {
          this.valueDec = value;
        }
      }
      set valueDec(v) {
        this._valueDec = v;
        this.isHexOnly = false;
        this.valueHexView = new Uint8Array(pvutils__namespace.utilEncodeTC(v));
      }
      get valueDec() {
        return this._valueDec;
      }
      fromDER(inputBuffer, inputOffset, inputLength, expectedLength = 0) {
        const offset = this.fromBER(inputBuffer, inputOffset, inputLength);
        if (offset === -1)
          return offset;
        const view = this.valueHexView;
        if (view[0] === 0 && (view[1] & 128) !== 0) {
          this.valueHexView = view.subarray(1);
        } else {
          if (expectedLength !== 0) {
            if (view.length < expectedLength) {
              if (expectedLength - view.length > 1)
                expectedLength = view.length + 1;
              this.valueHexView = view.subarray(expectedLength - view.length);
            }
          }
        }
        return offset;
      }
      toDER(sizeOnly = false) {
        const view = this.valueHexView;
        switch (true) {
          case (view[0] & 128) !== 0:
            {
              const updatedView = new Uint8Array(this.valueHexView.length + 1);
              updatedView[0] = 0;
              updatedView.set(view, 1);
              this.valueHexView = updatedView;
            }
            break;
          case (view[0] === 0 && (view[1] & 128) === 0):
            {
              this.valueHexView = this.valueHexView.subarray(1);
            }
            break;
        }
        return this.toBER(sizeOnly);
      }
      fromBER(inputBuffer, inputOffset, inputLength) {
        const resultOffset = super.fromBER(inputBuffer, inputOffset, inputLength);
        if (resultOffset === -1) {
          return resultOffset;
        }
        this.setValueHex();
        return resultOffset;
      }
      toBER(sizeOnly) {
        return sizeOnly ? new ArrayBuffer(this.valueHexView.length) : this.valueHexView.slice().buffer;
      }
      toJSON() {
        return {
          ...super.toJSON(),
          valueDec: this.valueDec
        };
      }
      toString() {
        const firstBit = this.valueHexView.length * 8 - 1;
        let digits = new Uint8Array(this.valueHexView.length * 8 / 3);
        let bitNumber = 0;
        let currentByte;
        const asn1View = this.valueHexView;
        let result = "";
        let flag = false;
        for (let byteNumber = asn1View.byteLength - 1; byteNumber >= 0; byteNumber--) {
          currentByte = asn1View[byteNumber];
          for (let i = 0; i < 8; i++) {
            if ((currentByte & 1) === 1) {
              switch (bitNumber) {
                case firstBit:
                  digits = viewSub(power2(bitNumber), digits);
                  result = "-";
                  break;
                default:
                  digits = viewAdd(digits, power2(bitNumber));
              }
            }
            bitNumber++;
            currentByte >>= 1;
          }
        }
        for (let i = 0; i < digits.length; i++) {
          if (digits[i])
            flag = true;
          if (flag)
            result += digitsString.charAt(digits[i]);
        }
        if (flag === false)
          result += digitsString.charAt(0);
        return result;
      }
    };
    _a$p = LocalIntegerValueBlock;
    LocalIntegerValueBlock.NAME = "IntegerValueBlock";
    (() => {
      Object.defineProperty(_a$p.prototype, "valueHex", {
        set: function(v) {
          this.valueHexView = new Uint8Array(v);
          this.setValueHex();
        },
        get: function() {
          return this.valueHexView.slice().buffer;
        }
      });
    })();
    var _a$o;
    var Integer = class extends BaseBlock {
      constructor(parameters = {}) {
        super(parameters, LocalIntegerValueBlock);
        this.idBlock.tagClass = 1;
        this.idBlock.tagNumber = 2;
      }
      toBigInt() {
        assertBigInt();
        return BigInt(this.valueBlock.toString());
      }
      static fromBigInt(value) {
        assertBigInt();
        const bigIntValue = BigInt(value);
        const writer = new ViewWriter();
        const hex = bigIntValue.toString(16).replace(/^-/, "");
        const view = new Uint8Array(pvtsutils__namespace.Convert.FromHex(hex));
        if (bigIntValue < 0) {
          const first = new Uint8Array(view.length + (view[0] & 128 ? 1 : 0));
          first[0] |= 128;
          const firstInt = BigInt(`0x${pvtsutils__namespace.Convert.ToHex(first)}`);
          const secondInt = firstInt + bigIntValue;
          const second = pvtsutils__namespace.BufferSourceConverter.toUint8Array(pvtsutils__namespace.Convert.FromHex(secondInt.toString(16)));
          second[0] |= 128;
          writer.write(second);
        } else {
          if (view[0] & 128) {
            writer.write(new Uint8Array([0]));
          }
          writer.write(view);
        }
        const res = new _a$o({ valueHex: writer.final() });
        return res;
      }
      convertToDER() {
        const integer = new _a$o({ valueHex: this.valueBlock.valueHexView });
        integer.valueBlock.toDER();
        return integer;
      }
      convertFromDER() {
        return new _a$o({
          valueHex: this.valueBlock.valueHexView[0] === 0 ? this.valueBlock.valueHexView.subarray(1) : this.valueBlock.valueHexView
        });
      }
      onAsciiEncoding() {
        return `${this.constructor.NAME} : ${this.valueBlock.toString()}`;
      }
    };
    _a$o = Integer;
    (() => {
      typeStore.Integer = _a$o;
    })();
    Integer.NAME = "INTEGER";
    var _a$n;
    var Enumerated = class extends Integer {
      constructor(parameters = {}) {
        super(parameters);
        this.idBlock.tagClass = 1;
        this.idBlock.tagNumber = 10;
      }
    };
    _a$n = Enumerated;
    (() => {
      typeStore.Enumerated = _a$n;
    })();
    Enumerated.NAME = "ENUMERATED";
    var LocalSidValueBlock = class extends HexBlock(ValueBlock) {
      constructor({ valueDec = -1, isFirstSid = false, ...parameters } = {}) {
        super(parameters);
        this.valueDec = valueDec;
        this.isFirstSid = isFirstSid;
      }
      fromBER(inputBuffer, inputOffset, inputLength) {
        if (!inputLength) {
          return inputOffset;
        }
        const inputView = pvtsutils__namespace.BufferSourceConverter.toUint8Array(inputBuffer);
        if (!checkBufferParams(this, inputView, inputOffset, inputLength)) {
          return -1;
        }
        const intBuffer = inputView.subarray(inputOffset, inputOffset + inputLength);
        this.valueHexView = new Uint8Array(inputLength);
        for (let i = 0; i < inputLength; i++) {
          this.valueHexView[i] = intBuffer[i] & 127;
          this.blockLength++;
          if ((intBuffer[i] & 128) === 0)
            break;
        }
        const tempView = new Uint8Array(this.blockLength);
        for (let i = 0; i < this.blockLength; i++) {
          tempView[i] = this.valueHexView[i];
        }
        this.valueHexView = tempView;
        if ((intBuffer[this.blockLength - 1] & 128) !== 0) {
          this.error = "End of input reached before message was fully decoded";
          return -1;
        }
        if (this.valueHexView[0] === 0)
          this.warnings.push("Needlessly long format of SID encoding");
        if (this.blockLength <= 8)
          this.valueDec = pvutils__namespace.utilFromBase(this.valueHexView, 7);
        else {
          this.isHexOnly = true;
          this.warnings.push("Too big SID for decoding, hex only");
        }
        return inputOffset + this.blockLength;
      }
      set valueBigInt(value) {
        assertBigInt();
        let bits = BigInt(value).toString(2);
        while (bits.length % 7) {
          bits = "0" + bits;
        }
        const bytes = new Uint8Array(bits.length / 7);
        for (let i = 0; i < bytes.length; i++) {
          bytes[i] = parseInt(bits.slice(i * 7, i * 7 + 7), 2) + (i + 1 < bytes.length ? 128 : 0);
        }
        this.fromBER(bytes.buffer, 0, bytes.length);
      }
      toBER(sizeOnly) {
        if (this.isHexOnly) {
          if (sizeOnly)
            return new ArrayBuffer(this.valueHexView.byteLength);
          const curView = this.valueHexView;
          const retView2 = new Uint8Array(this.blockLength);
          for (let i = 0; i < this.blockLength - 1; i++)
            retView2[i] = curView[i] | 128;
          retView2[this.blockLength - 1] = curView[this.blockLength - 1];
          return retView2.buffer;
        }
        const encodedBuf = pvutils__namespace.utilToBase(this.valueDec, 7);
        if (encodedBuf.byteLength === 0) {
          this.error = "Error during encoding SID value";
          return EMPTY_BUFFER;
        }
        const retView = new Uint8Array(encodedBuf.byteLength);
        if (!sizeOnly) {
          const encodedView = new Uint8Array(encodedBuf);
          const len = encodedBuf.byteLength - 1;
          for (let i = 0; i < len; i++)
            retView[i] = encodedView[i] | 128;
          retView[len] = encodedView[len];
        }
        return retView;
      }
      toString() {
        let result = "";
        if (this.isHexOnly)
          result = pvtsutils__namespace.Convert.ToHex(this.valueHexView);
        else {
          if (this.isFirstSid) {
            let sidValue = this.valueDec;
            if (this.valueDec <= 39)
              result = "0.";
            else {
              if (this.valueDec <= 79) {
                result = "1.";
                sidValue -= 40;
              } else {
                result = "2.";
                sidValue -= 80;
              }
            }
            result += sidValue.toString();
          } else
            result = this.valueDec.toString();
        }
        return result;
      }
      toJSON() {
        return {
          ...super.toJSON(),
          valueDec: this.valueDec,
          isFirstSid: this.isFirstSid
        };
      }
    };
    LocalSidValueBlock.NAME = "sidBlock";
    var LocalObjectIdentifierValueBlock = class extends ValueBlock {
      constructor({ value = EMPTY_STRING, ...parameters } = {}) {
        super(parameters);
        this.value = [];
        if (value) {
          this.fromString(value);
        }
      }
      fromBER(inputBuffer, inputOffset, inputLength) {
        let resultOffset = inputOffset;
        while (inputLength > 0) {
          const sidBlock = new LocalSidValueBlock();
          resultOffset = sidBlock.fromBER(inputBuffer, resultOffset, inputLength);
          if (resultOffset === -1) {
            this.blockLength = 0;
            this.error = sidBlock.error;
            return resultOffset;
          }
          if (this.value.length === 0)
            sidBlock.isFirstSid = true;
          this.blockLength += sidBlock.blockLength;
          inputLength -= sidBlock.blockLength;
          this.value.push(sidBlock);
        }
        return resultOffset;
      }
      toBER(sizeOnly) {
        const retBuffers = [];
        for (let i = 0; i < this.value.length; i++) {
          const valueBuf = this.value[i].toBER(sizeOnly);
          if (valueBuf.byteLength === 0) {
            this.error = this.value[i].error;
            return EMPTY_BUFFER;
          }
          retBuffers.push(valueBuf);
        }
        return concat(retBuffers);
      }
      fromString(string) {
        this.value = [];
        let pos1 = 0;
        let pos2 = 0;
        let sid = "";
        let flag = false;
        do {
          pos2 = string.indexOf(".", pos1);
          if (pos2 === -1)
            sid = string.substring(pos1);
          else
            sid = string.substring(pos1, pos2);
          pos1 = pos2 + 1;
          if (flag) {
            const sidBlock = this.value[0];
            let plus = 0;
            switch (sidBlock.valueDec) {
              case 0:
                break;
              case 1:
                plus = 40;
                break;
              case 2:
                plus = 80;
                break;
              default:
                this.value = [];
                return;
            }
            const parsedSID = parseInt(sid, 10);
            if (isNaN(parsedSID))
              return;
            sidBlock.valueDec = parsedSID + plus;
            flag = false;
          } else {
            const sidBlock = new LocalSidValueBlock();
            if (sid > Number.MAX_SAFE_INTEGER) {
              assertBigInt();
              const sidValue = BigInt(sid);
              sidBlock.valueBigInt = sidValue;
            } else {
              sidBlock.valueDec = parseInt(sid, 10);
              if (isNaN(sidBlock.valueDec))
                return;
            }
            if (!this.value.length) {
              sidBlock.isFirstSid = true;
              flag = true;
            }
            this.value.push(sidBlock);
          }
        } while (pos2 !== -1);
      }
      toString() {
        let result = "";
        let isHexOnly = false;
        for (let i = 0; i < this.value.length; i++) {
          isHexOnly = this.value[i].isHexOnly;
          let sidStr = this.value[i].toString();
          if (i !== 0)
            result = `${result}.`;
          if (isHexOnly) {
            sidStr = `{${sidStr}}`;
            if (this.value[i].isFirstSid)
              result = `2.{${sidStr} - 80}`;
            else
              result += sidStr;
          } else
            result += sidStr;
        }
        return result;
      }
      toJSON() {
        const object = {
          ...super.toJSON(),
          value: this.toString(),
          sidArray: []
        };
        for (let i = 0; i < this.value.length; i++) {
          object.sidArray.push(this.value[i].toJSON());
        }
        return object;
      }
    };
    LocalObjectIdentifierValueBlock.NAME = "ObjectIdentifierValueBlock";
    var _a$m;
    var ObjectIdentifier = class extends BaseBlock {
      getValue() {
        return this.valueBlock.toString();
      }
      setValue(value) {
        this.valueBlock.fromString(value);
      }
      constructor(parameters = {}) {
        super(parameters, LocalObjectIdentifierValueBlock);
        this.idBlock.tagClass = 1;
        this.idBlock.tagNumber = 6;
      }
      onAsciiEncoding() {
        return `${this.constructor.NAME} : ${this.valueBlock.toString() || "empty"}`;
      }
      toJSON() {
        return {
          ...super.toJSON(),
          value: this.getValue()
        };
      }
    };
    _a$m = ObjectIdentifier;
    (() => {
      typeStore.ObjectIdentifier = _a$m;
    })();
    ObjectIdentifier.NAME = "OBJECT IDENTIFIER";
    var LocalRelativeSidValueBlock = class extends HexBlock(LocalBaseBlock) {
      constructor({ valueDec = 0, ...parameters } = {}) {
        super(parameters);
        this.valueDec = valueDec;
      }
      fromBER(inputBuffer, inputOffset, inputLength) {
        if (inputLength === 0)
          return inputOffset;
        const inputView = pvtsutils__namespace.BufferSourceConverter.toUint8Array(inputBuffer);
        if (!checkBufferParams(this, inputView, inputOffset, inputLength))
          return -1;
        const intBuffer = inputView.subarray(inputOffset, inputOffset + inputLength);
        this.valueHexView = new Uint8Array(inputLength);
        for (let i = 0; i < inputLength; i++) {
          this.valueHexView[i] = intBuffer[i] & 127;
          this.blockLength++;
          if ((intBuffer[i] & 128) === 0)
            break;
        }
        const tempView = new Uint8Array(this.blockLength);
        for (let i = 0; i < this.blockLength; i++)
          tempView[i] = this.valueHexView[i];
        this.valueHexView = tempView;
        if ((intBuffer[this.blockLength - 1] & 128) !== 0) {
          this.error = "End of input reached before message was fully decoded";
          return -1;
        }
        if (this.valueHexView[0] === 0)
          this.warnings.push("Needlessly long format of SID encoding");
        if (this.blockLength <= 8)
          this.valueDec = pvutils__namespace.utilFromBase(this.valueHexView, 7);
        else {
          this.isHexOnly = true;
          this.warnings.push("Too big SID for decoding, hex only");
        }
        return inputOffset + this.blockLength;
      }
      toBER(sizeOnly) {
        if (this.isHexOnly) {
          if (sizeOnly)
            return new ArrayBuffer(this.valueHexView.byteLength);
          const curView = this.valueHexView;
          const retView2 = new Uint8Array(this.blockLength);
          for (let i = 0; i < this.blockLength - 1; i++)
            retView2[i] = curView[i] | 128;
          retView2[this.blockLength - 1] = curView[this.blockLength - 1];
          return retView2.buffer;
        }
        const encodedBuf = pvutils__namespace.utilToBase(this.valueDec, 7);
        if (encodedBuf.byteLength === 0) {
          this.error = "Error during encoding SID value";
          return EMPTY_BUFFER;
        }
        const retView = new Uint8Array(encodedBuf.byteLength);
        if (!sizeOnly) {
          const encodedView = new Uint8Array(encodedBuf);
          const len = encodedBuf.byteLength - 1;
          for (let i = 0; i < len; i++)
            retView[i] = encodedView[i] | 128;
          retView[len] = encodedView[len];
        }
        return retView.buffer;
      }
      toString() {
        let result = "";
        if (this.isHexOnly)
          result = pvtsutils__namespace.Convert.ToHex(this.valueHexView);
        else {
          result = this.valueDec.toString();
        }
        return result;
      }
      toJSON() {
        return {
          ...super.toJSON(),
          valueDec: this.valueDec
        };
      }
    };
    LocalRelativeSidValueBlock.NAME = "relativeSidBlock";
    var LocalRelativeObjectIdentifierValueBlock = class extends ValueBlock {
      constructor({ value = EMPTY_STRING, ...parameters } = {}) {
        super(parameters);
        this.value = [];
        if (value) {
          this.fromString(value);
        }
      }
      fromBER(inputBuffer, inputOffset, inputLength) {
        let resultOffset = inputOffset;
        while (inputLength > 0) {
          const sidBlock = new LocalRelativeSidValueBlock();
          resultOffset = sidBlock.fromBER(inputBuffer, resultOffset, inputLength);
          if (resultOffset === -1) {
            this.blockLength = 0;
            this.error = sidBlock.error;
            return resultOffset;
          }
          this.blockLength += sidBlock.blockLength;
          inputLength -= sidBlock.blockLength;
          this.value.push(sidBlock);
        }
        return resultOffset;
      }
      toBER(sizeOnly, _writer) {
        const retBuffers = [];
        for (let i = 0; i < this.value.length; i++) {
          const valueBuf = this.value[i].toBER(sizeOnly);
          if (valueBuf.byteLength === 0) {
            this.error = this.value[i].error;
            return EMPTY_BUFFER;
          }
          retBuffers.push(valueBuf);
        }
        return concat(retBuffers);
      }
      fromString(string) {
        this.value = [];
        let pos1 = 0;
        let pos2 = 0;
        let sid = "";
        do {
          pos2 = string.indexOf(".", pos1);
          if (pos2 === -1)
            sid = string.substring(pos1);
          else
            sid = string.substring(pos1, pos2);
          pos1 = pos2 + 1;
          const sidBlock = new LocalRelativeSidValueBlock();
          sidBlock.valueDec = parseInt(sid, 10);
          if (isNaN(sidBlock.valueDec))
            return true;
          this.value.push(sidBlock);
        } while (pos2 !== -1);
        return true;
      }
      toString() {
        let result = "";
        let isHexOnly = false;
        for (let i = 0; i < this.value.length; i++) {
          isHexOnly = this.value[i].isHexOnly;
          let sidStr = this.value[i].toString();
          if (i !== 0)
            result = `${result}.`;
          if (isHexOnly) {
            sidStr = `{${sidStr}}`;
            result += sidStr;
          } else
            result += sidStr;
        }
        return result;
      }
      toJSON() {
        const object = {
          ...super.toJSON(),
          value: this.toString(),
          sidArray: []
        };
        for (let i = 0; i < this.value.length; i++)
          object.sidArray.push(this.value[i].toJSON());
        return object;
      }
    };
    LocalRelativeObjectIdentifierValueBlock.NAME = "RelativeObjectIdentifierValueBlock";
    var _a$l;
    var RelativeObjectIdentifier = class extends BaseBlock {
      getValue() {
        return this.valueBlock.toString();
      }
      setValue(value) {
        this.valueBlock.fromString(value);
      }
      constructor(parameters = {}) {
        super(parameters, LocalRelativeObjectIdentifierValueBlock);
        this.idBlock.tagClass = 1;
        this.idBlock.tagNumber = 13;
      }
      onAsciiEncoding() {
        return `${this.constructor.NAME} : ${this.valueBlock.toString() || "empty"}`;
      }
      toJSON() {
        return {
          ...super.toJSON(),
          value: this.getValue()
        };
      }
    };
    _a$l = RelativeObjectIdentifier;
    (() => {
      typeStore.RelativeObjectIdentifier = _a$l;
    })();
    RelativeObjectIdentifier.NAME = "RelativeObjectIdentifier";
    var _a$k;
    var Sequence = class extends Constructed {
      constructor(parameters = {}) {
        super(parameters);
        this.idBlock.tagClass = 1;
        this.idBlock.tagNumber = 16;
      }
    };
    _a$k = Sequence;
    (() => {
      typeStore.Sequence = _a$k;
    })();
    Sequence.NAME = "SEQUENCE";
    var _a$j;
    var Set2 = class extends Constructed {
      constructor(parameters = {}) {
        super(parameters);
        this.idBlock.tagClass = 1;
        this.idBlock.tagNumber = 17;
      }
    };
    _a$j = Set2;
    (() => {
      typeStore.Set = _a$j;
    })();
    Set2.NAME = "SET";
    var LocalStringValueBlock = class extends HexBlock(ValueBlock) {
      constructor({ ...parameters } = {}) {
        super(parameters);
        this.isHexOnly = true;
        this.value = EMPTY_STRING;
      }
      toJSON() {
        return {
          ...super.toJSON(),
          value: this.value
        };
      }
    };
    LocalStringValueBlock.NAME = "StringValueBlock";
    var LocalSimpleStringValueBlock = class extends LocalStringValueBlock {
    };
    LocalSimpleStringValueBlock.NAME = "SimpleStringValueBlock";
    var LocalSimpleStringBlock = class extends BaseStringBlock {
      constructor({ ...parameters } = {}) {
        super(parameters, LocalSimpleStringValueBlock);
      }
      fromBuffer(inputBuffer) {
        this.valueBlock.value = String.fromCharCode.apply(null, pvtsutils__namespace.BufferSourceConverter.toUint8Array(inputBuffer));
      }
      fromString(inputString) {
        const strLen = inputString.length;
        const view = this.valueBlock.valueHexView = new Uint8Array(strLen);
        for (let i = 0; i < strLen; i++)
          view[i] = inputString.charCodeAt(i);
        this.valueBlock.value = inputString;
      }
    };
    LocalSimpleStringBlock.NAME = "SIMPLE STRING";
    var LocalUtf8StringValueBlock = class extends LocalSimpleStringBlock {
      fromBuffer(inputBuffer) {
        this.valueBlock.valueHexView = pvtsutils__namespace.BufferSourceConverter.toUint8Array(inputBuffer);
        try {
          this.valueBlock.value = pvtsutils__namespace.Convert.ToUtf8String(inputBuffer);
        } catch (ex) {
          this.warnings.push(`Error during "decodeURIComponent": ${ex}, using raw string`);
          this.valueBlock.value = pvtsutils__namespace.Convert.ToBinary(inputBuffer);
        }
      }
      fromString(inputString) {
        this.valueBlock.valueHexView = new Uint8Array(pvtsutils__namespace.Convert.FromUtf8String(inputString));
        this.valueBlock.value = inputString;
      }
    };
    LocalUtf8StringValueBlock.NAME = "Utf8StringValueBlock";
    var _a$i;
    var Utf8String = class extends LocalUtf8StringValueBlock {
      constructor(parameters = {}) {
        super(parameters);
        this.idBlock.tagClass = 1;
        this.idBlock.tagNumber = 12;
      }
    };
    _a$i = Utf8String;
    (() => {
      typeStore.Utf8String = _a$i;
    })();
    Utf8String.NAME = "UTF8String";
    var LocalBmpStringValueBlock = class extends LocalSimpleStringBlock {
      fromBuffer(inputBuffer) {
        this.valueBlock.value = pvtsutils__namespace.Convert.ToUtf16String(inputBuffer);
        this.valueBlock.valueHexView = pvtsutils__namespace.BufferSourceConverter.toUint8Array(inputBuffer);
      }
      fromString(inputString) {
        this.valueBlock.value = inputString;
        this.valueBlock.valueHexView = new Uint8Array(pvtsutils__namespace.Convert.FromUtf16String(inputString));
      }
    };
    LocalBmpStringValueBlock.NAME = "BmpStringValueBlock";
    var _a$h;
    var BmpString = class extends LocalBmpStringValueBlock {
      constructor({ ...parameters } = {}) {
        super(parameters);
        this.idBlock.tagClass = 1;
        this.idBlock.tagNumber = 30;
      }
    };
    _a$h = BmpString;
    (() => {
      typeStore.BmpString = _a$h;
    })();
    BmpString.NAME = "BMPString";
    var LocalUniversalStringValueBlock = class extends LocalSimpleStringBlock {
      fromBuffer(inputBuffer) {
        const copyBuffer = ArrayBuffer.isView(inputBuffer) ? inputBuffer.slice().buffer : inputBuffer.slice(0);
        const valueView = new Uint8Array(copyBuffer);
        for (let i = 0; i < valueView.length; i += 4) {
          valueView[i] = valueView[i + 3];
          valueView[i + 1] = valueView[i + 2];
          valueView[i + 2] = 0;
          valueView[i + 3] = 0;
        }
        this.valueBlock.value = String.fromCharCode.apply(null, new Uint32Array(copyBuffer));
      }
      fromString(inputString) {
        const strLength = inputString.length;
        const valueHexView = this.valueBlock.valueHexView = new Uint8Array(strLength * 4);
        for (let i = 0; i < strLength; i++) {
          const codeBuf = pvutils__namespace.utilToBase(inputString.charCodeAt(i), 8);
          const codeView = new Uint8Array(codeBuf);
          if (codeView.length > 4)
            continue;
          const dif = 4 - codeView.length;
          for (let j = codeView.length - 1; j >= 0; j--)
            valueHexView[i * 4 + j + dif] = codeView[j];
        }
        this.valueBlock.value = inputString;
      }
    };
    LocalUniversalStringValueBlock.NAME = "UniversalStringValueBlock";
    var _a$g;
    var UniversalString = class extends LocalUniversalStringValueBlock {
      constructor({ ...parameters } = {}) {
        super(parameters);
        this.idBlock.tagClass = 1;
        this.idBlock.tagNumber = 28;
      }
    };
    _a$g = UniversalString;
    (() => {
      typeStore.UniversalString = _a$g;
    })();
    UniversalString.NAME = "UniversalString";
    var _a$f;
    var NumericString = class extends LocalSimpleStringBlock {
      constructor(parameters = {}) {
        super(parameters);
        this.idBlock.tagClass = 1;
        this.idBlock.tagNumber = 18;
      }
    };
    _a$f = NumericString;
    (() => {
      typeStore.NumericString = _a$f;
    })();
    NumericString.NAME = "NumericString";
    var _a$e;
    var PrintableString = class extends LocalSimpleStringBlock {
      constructor(parameters = {}) {
        super(parameters);
        this.idBlock.tagClass = 1;
        this.idBlock.tagNumber = 19;
      }
    };
    _a$e = PrintableString;
    (() => {
      typeStore.PrintableString = _a$e;
    })();
    PrintableString.NAME = "PrintableString";
    var _a$d;
    var TeletexString = class extends LocalSimpleStringBlock {
      constructor(parameters = {}) {
        super(parameters);
        this.idBlock.tagClass = 1;
        this.idBlock.tagNumber = 20;
      }
    };
    _a$d = TeletexString;
    (() => {
      typeStore.TeletexString = _a$d;
    })();
    TeletexString.NAME = "TeletexString";
    var _a$c;
    var VideotexString = class extends LocalSimpleStringBlock {
      constructor(parameters = {}) {
        super(parameters);
        this.idBlock.tagClass = 1;
        this.idBlock.tagNumber = 21;
      }
    };
    _a$c = VideotexString;
    (() => {
      typeStore.VideotexString = _a$c;
    })();
    VideotexString.NAME = "VideotexString";
    var _a$b;
    var IA5String = class extends LocalSimpleStringBlock {
      constructor(parameters = {}) {
        super(parameters);
        this.idBlock.tagClass = 1;
        this.idBlock.tagNumber = 22;
      }
    };
    _a$b = IA5String;
    (() => {
      typeStore.IA5String = _a$b;
    })();
    IA5String.NAME = "IA5String";
    var _a$a;
    var GraphicString = class extends LocalSimpleStringBlock {
      constructor(parameters = {}) {
        super(parameters);
        this.idBlock.tagClass = 1;
        this.idBlock.tagNumber = 25;
      }
    };
    _a$a = GraphicString;
    (() => {
      typeStore.GraphicString = _a$a;
    })();
    GraphicString.NAME = "GraphicString";
    var _a$9;
    var VisibleString = class extends LocalSimpleStringBlock {
      constructor(parameters = {}) {
        super(parameters);
        this.idBlock.tagClass = 1;
        this.idBlock.tagNumber = 26;
      }
    };
    _a$9 = VisibleString;
    (() => {
      typeStore.VisibleString = _a$9;
    })();
    VisibleString.NAME = "VisibleString";
    var _a$8;
    var GeneralString = class extends LocalSimpleStringBlock {
      constructor(parameters = {}) {
        super(parameters);
        this.idBlock.tagClass = 1;
        this.idBlock.tagNumber = 27;
      }
    };
    _a$8 = GeneralString;
    (() => {
      typeStore.GeneralString = _a$8;
    })();
    GeneralString.NAME = "GeneralString";
    var _a$7;
    var CharacterString = class extends LocalSimpleStringBlock {
      constructor(parameters = {}) {
        super(parameters);
        this.idBlock.tagClass = 1;
        this.idBlock.tagNumber = 29;
      }
    };
    _a$7 = CharacterString;
    (() => {
      typeStore.CharacterString = _a$7;
    })();
    CharacterString.NAME = "CharacterString";
    var _a$6;
    var UTCTime = class extends VisibleString {
      constructor({ value, valueDate, ...parameters } = {}) {
        super(parameters);
        this.year = 0;
        this.month = 0;
        this.day = 0;
        this.hour = 0;
        this.minute = 0;
        this.second = 0;
        if (value) {
          this.fromString(value);
          this.valueBlock.valueHexView = new Uint8Array(value.length);
          for (let i = 0; i < value.length; i++)
            this.valueBlock.valueHexView[i] = value.charCodeAt(i);
        }
        if (valueDate) {
          this.fromDate(valueDate);
          this.valueBlock.valueHexView = new Uint8Array(this.toBuffer());
        }
        this.idBlock.tagClass = 1;
        this.idBlock.tagNumber = 23;
      }
      fromBuffer(inputBuffer) {
        this.fromString(String.fromCharCode.apply(null, pvtsutils__namespace.BufferSourceConverter.toUint8Array(inputBuffer)));
      }
      toBuffer() {
        const str = this.toString();
        const buffer = new ArrayBuffer(str.length);
        const view = new Uint8Array(buffer);
        for (let i = 0; i < str.length; i++)
          view[i] = str.charCodeAt(i);
        return buffer;
      }
      fromDate(inputDate) {
        this.year = inputDate.getUTCFullYear();
        this.month = inputDate.getUTCMonth() + 1;
        this.day = inputDate.getUTCDate();
        this.hour = inputDate.getUTCHours();
        this.minute = inputDate.getUTCMinutes();
        this.second = inputDate.getUTCSeconds();
      }
      toDate() {
        return new Date(Date.UTC(this.year, this.month - 1, this.day, this.hour, this.minute, this.second));
      }
      fromString(inputString) {
        const parser = /(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z/ig;
        const parserArray = parser.exec(inputString);
        if (parserArray === null) {
          this.error = "Wrong input string for conversion";
          return;
        }
        const year = parseInt(parserArray[1], 10);
        if (year >= 50)
          this.year = 1900 + year;
        else
          this.year = 2e3 + year;
        this.month = parseInt(parserArray[2], 10);
        this.day = parseInt(parserArray[3], 10);
        this.hour = parseInt(parserArray[4], 10);
        this.minute = parseInt(parserArray[5], 10);
        this.second = parseInt(parserArray[6], 10);
      }
      toString(encoding = "iso") {
        if (encoding === "iso") {
          const outputArray = new Array(7);
          outputArray[0] = pvutils__namespace.padNumber(this.year < 2e3 ? this.year - 1900 : this.year - 2e3, 2);
          outputArray[1] = pvutils__namespace.padNumber(this.month, 2);
          outputArray[2] = pvutils__namespace.padNumber(this.day, 2);
          outputArray[3] = pvutils__namespace.padNumber(this.hour, 2);
          outputArray[4] = pvutils__namespace.padNumber(this.minute, 2);
          outputArray[5] = pvutils__namespace.padNumber(this.second, 2);
          outputArray[6] = "Z";
          return outputArray.join("");
        }
        return super.toString(encoding);
      }
      onAsciiEncoding() {
        return `${this.constructor.NAME} : ${this.toDate().toISOString()}`;
      }
      toJSON() {
        return {
          ...super.toJSON(),
          year: this.year,
          month: this.month,
          day: this.day,
          hour: this.hour,
          minute: this.minute,
          second: this.second
        };
      }
    };
    _a$6 = UTCTime;
    (() => {
      typeStore.UTCTime = _a$6;
    })();
    UTCTime.NAME = "UTCTime";
    var _a$5;
    var GeneralizedTime = class extends UTCTime {
      constructor(parameters = {}) {
        var _b;
        super(parameters);
        (_b = this.millisecond) !== null && _b !== void 0 ? _b : this.millisecond = 0;
        this.idBlock.tagClass = 1;
        this.idBlock.tagNumber = 24;
      }
      fromDate(inputDate) {
        super.fromDate(inputDate);
        this.millisecond = inputDate.getUTCMilliseconds();
      }
      toDate() {
        const utcDate = Date.UTC(this.year, this.month - 1, this.day, this.hour, this.minute, this.second, this.millisecond);
        return new Date(utcDate);
      }
      fromString(inputString) {
        let isUTC = false;
        let timeString = "";
        let dateTimeString = "";
        let fractionPart = 0;
        let parser;
        let hourDifference = 0;
        let minuteDifference = 0;
        if (inputString[inputString.length - 1] === "Z") {
          timeString = inputString.substring(0, inputString.length - 1);
          isUTC = true;
        } else {
          const number = new Number(inputString[inputString.length - 1]);
          if (isNaN(number.valueOf()))
            throw new Error("Wrong input string for conversion");
          timeString = inputString;
        }
        if (isUTC) {
          if (timeString.indexOf("+") !== -1)
            throw new Error("Wrong input string for conversion");
          if (timeString.indexOf("-") !== -1)
            throw new Error("Wrong input string for conversion");
        } else {
          let multiplier = 1;
          let differencePosition = timeString.indexOf("+");
          let differenceString = "";
          if (differencePosition === -1) {
            differencePosition = timeString.indexOf("-");
            multiplier = -1;
          }
          if (differencePosition !== -1) {
            differenceString = timeString.substring(differencePosition + 1);
            timeString = timeString.substring(0, differencePosition);
            if (differenceString.length !== 2 && differenceString.length !== 4)
              throw new Error("Wrong input string for conversion");
            let number = parseInt(differenceString.substring(0, 2), 10);
            if (isNaN(number.valueOf()))
              throw new Error("Wrong input string for conversion");
            hourDifference = multiplier * number;
            if (differenceString.length === 4) {
              number = parseInt(differenceString.substring(2, 4), 10);
              if (isNaN(number.valueOf()))
                throw new Error("Wrong input string for conversion");
              minuteDifference = multiplier * number;
            }
          }
        }
        let fractionPointPosition = timeString.indexOf(".");
        if (fractionPointPosition === -1)
          fractionPointPosition = timeString.indexOf(",");
        if (fractionPointPosition !== -1) {
          const fractionPartCheck = new Number(`0${timeString.substring(fractionPointPosition)}`);
          if (isNaN(fractionPartCheck.valueOf()))
            throw new Error("Wrong input string for conversion");
          fractionPart = fractionPartCheck.valueOf();
          dateTimeString = timeString.substring(0, fractionPointPosition);
        } else
          dateTimeString = timeString;
        switch (true) {
          case dateTimeString.length === 8:
            parser = /(\d{4})(\d{2})(\d{2})/ig;
            if (fractionPointPosition !== -1)
              throw new Error("Wrong input string for conversion");
            break;
          case dateTimeString.length === 10:
            parser = /(\d{4})(\d{2})(\d{2})(\d{2})/ig;
            if (fractionPointPosition !== -1) {
              let fractionResult = 60 * fractionPart;
              this.minute = Math.floor(fractionResult);
              fractionResult = 60 * (fractionResult - this.minute);
              this.second = Math.floor(fractionResult);
              fractionResult = 1e3 * (fractionResult - this.second);
              this.millisecond = Math.floor(fractionResult);
            }
            break;
          case dateTimeString.length === 12:
            parser = /(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})/ig;
            if (fractionPointPosition !== -1) {
              let fractionResult = 60 * fractionPart;
              this.second = Math.floor(fractionResult);
              fractionResult = 1e3 * (fractionResult - this.second);
              this.millisecond = Math.floor(fractionResult);
            }
            break;
          case dateTimeString.length === 14:
            parser = /(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/ig;
            if (fractionPointPosition !== -1) {
              const fractionResult = 1e3 * fractionPart;
              this.millisecond = Math.floor(fractionResult);
            }
            break;
          default:
            throw new Error("Wrong input string for conversion");
        }
        const parserArray = parser.exec(dateTimeString);
        if (parserArray === null)
          throw new Error("Wrong input string for conversion");
        for (let j = 1; j < parserArray.length; j++) {
          switch (j) {
            case 1:
              this.year = parseInt(parserArray[j], 10);
              break;
            case 2:
              this.month = parseInt(parserArray[j], 10);
              break;
            case 3:
              this.day = parseInt(parserArray[j], 10);
              break;
            case 4:
              this.hour = parseInt(parserArray[j], 10) + hourDifference;
              break;
            case 5:
              this.minute = parseInt(parserArray[j], 10) + minuteDifference;
              break;
            case 6:
              this.second = parseInt(parserArray[j], 10);
              break;
            default:
              throw new Error("Wrong input string for conversion");
          }
        }
        if (isUTC === false) {
          const tempDate = new Date(this.year, this.month, this.day, this.hour, this.minute, this.second, this.millisecond);
          this.year = tempDate.getUTCFullYear();
          this.month = tempDate.getUTCMonth();
          this.day = tempDate.getUTCDay();
          this.hour = tempDate.getUTCHours();
          this.minute = tempDate.getUTCMinutes();
          this.second = tempDate.getUTCSeconds();
          this.millisecond = tempDate.getUTCMilliseconds();
        }
      }
      toString(encoding = "iso") {
        if (encoding === "iso") {
          const outputArray = [];
          outputArray.push(pvutils__namespace.padNumber(this.year, 4));
          outputArray.push(pvutils__namespace.padNumber(this.month, 2));
          outputArray.push(pvutils__namespace.padNumber(this.day, 2));
          outputArray.push(pvutils__namespace.padNumber(this.hour, 2));
          outputArray.push(pvutils__namespace.padNumber(this.minute, 2));
          outputArray.push(pvutils__namespace.padNumber(this.second, 2));
          if (this.millisecond !== 0) {
            outputArray.push(".");
            outputArray.push(pvutils__namespace.padNumber(this.millisecond, 3));
          }
          outputArray.push("Z");
          return outputArray.join("");
        }
        return super.toString(encoding);
      }
      toJSON() {
        return {
          ...super.toJSON(),
          millisecond: this.millisecond
        };
      }
    };
    _a$5 = GeneralizedTime;
    (() => {
      typeStore.GeneralizedTime = _a$5;
    })();
    GeneralizedTime.NAME = "GeneralizedTime";
    var _a$4;
    var DATE = class extends Utf8String {
      constructor(parameters = {}) {
        super(parameters);
        this.idBlock.tagClass = 1;
        this.idBlock.tagNumber = 31;
      }
    };
    _a$4 = DATE;
    (() => {
      typeStore.DATE = _a$4;
    })();
    DATE.NAME = "DATE";
    var _a$3;
    var TimeOfDay = class extends Utf8String {
      constructor(parameters = {}) {
        super(parameters);
        this.idBlock.tagClass = 1;
        this.idBlock.tagNumber = 32;
      }
    };
    _a$3 = TimeOfDay;
    (() => {
      typeStore.TimeOfDay = _a$3;
    })();
    TimeOfDay.NAME = "TimeOfDay";
    var _a$2;
    var DateTime = class extends Utf8String {
      constructor(parameters = {}) {
        super(parameters);
        this.idBlock.tagClass = 1;
        this.idBlock.tagNumber = 33;
      }
    };
    _a$2 = DateTime;
    (() => {
      typeStore.DateTime = _a$2;
    })();
    DateTime.NAME = "DateTime";
    var _a$1;
    var Duration = class extends Utf8String {
      constructor(parameters = {}) {
        super(parameters);
        this.idBlock.tagClass = 1;
        this.idBlock.tagNumber = 34;
      }
    };
    _a$1 = Duration;
    (() => {
      typeStore.Duration = _a$1;
    })();
    Duration.NAME = "Duration";
    var _a;
    var TIME = class extends Utf8String {
      constructor(parameters = {}) {
        super(parameters);
        this.idBlock.tagClass = 1;
        this.idBlock.tagNumber = 14;
      }
    };
    _a = TIME;
    (() => {
      typeStore.TIME = _a;
    })();
    TIME.NAME = "TIME";
    var Any = class {
      constructor({ name = EMPTY_STRING, optional = false } = {}) {
        this.name = name;
        this.optional = optional;
      }
    };
    var Choice = class extends Any {
      constructor({ value = [], ...parameters } = {}) {
        super(parameters);
        this.value = value;
      }
    };
    var Repeated = class extends Any {
      constructor({ value = new Any(), local = false, ...parameters } = {}) {
        super(parameters);
        this.value = value;
        this.local = local;
      }
    };
    var RawData = class {
      get data() {
        return this.dataView.slice().buffer;
      }
      set data(value) {
        this.dataView = pvtsutils__namespace.BufferSourceConverter.toUint8Array(value);
      }
      constructor({ data = EMPTY_VIEW } = {}) {
        this.dataView = pvtsutils__namespace.BufferSourceConverter.toUint8Array(data);
      }
      fromBER(inputBuffer, inputOffset, inputLength) {
        const endLength = inputOffset + inputLength;
        this.dataView = pvtsutils__namespace.BufferSourceConverter.toUint8Array(inputBuffer).subarray(inputOffset, endLength);
        return endLength;
      }
      toBER(_sizeOnly) {
        return this.dataView.slice().buffer;
      }
    };
    function compareSchema(root, inputData, inputSchema) {
      if (inputSchema instanceof Choice) {
        for (const element of inputSchema.value) {
          const result = compareSchema(root, inputData, element);
          if (result.verified) {
            return {
              verified: true,
              result: root
            };
          }
        }
        {
          const _result = {
            verified: false,
            result: { error: "Wrong values for Choice type" }
          };
          if (inputSchema.hasOwnProperty(NAME))
            _result.name = inputSchema.name;
          return _result;
        }
      }
      if (inputSchema instanceof Any) {
        if (inputSchema.hasOwnProperty(NAME))
          root[inputSchema.name] = inputData;
        return {
          verified: true,
          result: root
        };
      }
      if (root instanceof Object === false) {
        return {
          verified: false,
          result: { error: "Wrong root object" }
        };
      }
      if (inputData instanceof Object === false) {
        return {
          verified: false,
          result: { error: "Wrong ASN.1 data" }
        };
      }
      if (inputSchema instanceof Object === false) {
        return {
          verified: false,
          result: { error: "Wrong ASN.1 schema" }
        };
      }
      if (ID_BLOCK in inputSchema === false) {
        return {
          verified: false,
          result: { error: "Wrong ASN.1 schema" }
        };
      }
      if (FROM_BER in inputSchema.idBlock === false) {
        return {
          verified: false,
          result: { error: "Wrong ASN.1 schema" }
        };
      }
      if (TO_BER in inputSchema.idBlock === false) {
        return {
          verified: false,
          result: { error: "Wrong ASN.1 schema" }
        };
      }
      const encodedId = inputSchema.idBlock.toBER(false);
      if (encodedId.byteLength === 0) {
        return {
          verified: false,
          result: { error: "Error encoding idBlock for ASN.1 schema" }
        };
      }
      const decodedOffset = inputSchema.idBlock.fromBER(encodedId, 0, encodedId.byteLength);
      if (decodedOffset === -1) {
        return {
          verified: false,
          result: { error: "Error decoding idBlock for ASN.1 schema" }
        };
      }
      if (inputSchema.idBlock.hasOwnProperty(TAG_CLASS) === false) {
        return {
          verified: false,
          result: { error: "Wrong ASN.1 schema" }
        };
      }
      if (inputSchema.idBlock.tagClass !== inputData.idBlock.tagClass) {
        return {
          verified: false,
          result: root
        };
      }
      if (inputSchema.idBlock.hasOwnProperty(TAG_NUMBER) === false) {
        return {
          verified: false,
          result: { error: "Wrong ASN.1 schema" }
        };
      }
      if (inputSchema.idBlock.tagNumber !== inputData.idBlock.tagNumber) {
        return {
          verified: false,
          result: root
        };
      }
      if (inputSchema.idBlock.hasOwnProperty(IS_CONSTRUCTED) === false) {
        return {
          verified: false,
          result: { error: "Wrong ASN.1 schema" }
        };
      }
      if (inputSchema.idBlock.isConstructed !== inputData.idBlock.isConstructed) {
        return {
          verified: false,
          result: root
        };
      }
      if (!(IS_HEX_ONLY in inputSchema.idBlock)) {
        return {
          verified: false,
          result: { error: "Wrong ASN.1 schema" }
        };
      }
      if (inputSchema.idBlock.isHexOnly !== inputData.idBlock.isHexOnly) {
        return {
          verified: false,
          result: root
        };
      }
      if (inputSchema.idBlock.isHexOnly) {
        if (VALUE_HEX_VIEW in inputSchema.idBlock === false) {
          return {
            verified: false,
            result: { error: "Wrong ASN.1 schema" }
          };
        }
        const schemaView = inputSchema.idBlock.valueHexView;
        const asn1View = inputData.idBlock.valueHexView;
        if (schemaView.length !== asn1View.length) {
          return {
            verified: false,
            result: root
          };
        }
        for (let i = 0; i < schemaView.length; i++) {
          if (schemaView[i] !== asn1View[1]) {
            return {
              verified: false,
              result: root
            };
          }
        }
      }
      if (inputSchema.name) {
        inputSchema.name = inputSchema.name.replace(/^\s+|\s+$/g, EMPTY_STRING);
        if (inputSchema.name)
          root[inputSchema.name] = inputData;
      }
      if (inputSchema instanceof typeStore.Constructed) {
        let admission = 0;
        let result = {
          verified: false,
          result: { error: "Unknown error" }
        };
        let maxLength = inputSchema.valueBlock.value.length;
        if (maxLength > 0) {
          if (inputSchema.valueBlock.value[0] instanceof Repeated) {
            maxLength = inputData.valueBlock.value.length;
          }
        }
        if (maxLength === 0) {
          return {
            verified: true,
            result: root
          };
        }
        if (inputData.valueBlock.value.length === 0 && inputSchema.valueBlock.value.length !== 0) {
          let _optional = true;
          for (let i = 0; i < inputSchema.valueBlock.value.length; i++)
            _optional = _optional && (inputSchema.valueBlock.value[i].optional || false);
          if (_optional) {
            return {
              verified: true,
              result: root
            };
          }
          if (inputSchema.name) {
            inputSchema.name = inputSchema.name.replace(/^\s+|\s+$/g, EMPTY_STRING);
            if (inputSchema.name)
              delete root[inputSchema.name];
          }
          root.error = "Inconsistent object length";
          return {
            verified: false,
            result: root
          };
        }
        for (let i = 0; i < maxLength; i++) {
          if (i - admission >= inputData.valueBlock.value.length) {
            if (inputSchema.valueBlock.value[i].optional === false) {
              const _result = {
                verified: false,
                result: root
              };
              root.error = "Inconsistent length between ASN.1 data and schema";
              if (inputSchema.name) {
                inputSchema.name = inputSchema.name.replace(/^\s+|\s+$/g, EMPTY_STRING);
                if (inputSchema.name) {
                  delete root[inputSchema.name];
                  _result.name = inputSchema.name;
                }
              }
              return _result;
            }
          } else {
            if (inputSchema.valueBlock.value[0] instanceof Repeated) {
              result = compareSchema(root, inputData.valueBlock.value[i], inputSchema.valueBlock.value[0].value);
              if (result.verified === false) {
                if (inputSchema.valueBlock.value[0].optional)
                  admission++;
                else {
                  if (inputSchema.name) {
                    inputSchema.name = inputSchema.name.replace(/^\s+|\s+$/g, EMPTY_STRING);
                    if (inputSchema.name)
                      delete root[inputSchema.name];
                  }
                  return result;
                }
              }
              if (NAME in inputSchema.valueBlock.value[0] && inputSchema.valueBlock.value[0].name.length > 0) {
                let arrayRoot = {};
                if (LOCAL in inputSchema.valueBlock.value[0] && inputSchema.valueBlock.value[0].local)
                  arrayRoot = inputData;
                else
                  arrayRoot = root;
                if (typeof arrayRoot[inputSchema.valueBlock.value[0].name] === "undefined")
                  arrayRoot[inputSchema.valueBlock.value[0].name] = [];
                arrayRoot[inputSchema.valueBlock.value[0].name].push(inputData.valueBlock.value[i]);
              }
            } else {
              result = compareSchema(root, inputData.valueBlock.value[i - admission], inputSchema.valueBlock.value[i]);
              if (result.verified === false) {
                if (inputSchema.valueBlock.value[i].optional)
                  admission++;
                else {
                  if (inputSchema.name) {
                    inputSchema.name = inputSchema.name.replace(/^\s+|\s+$/g, EMPTY_STRING);
                    if (inputSchema.name)
                      delete root[inputSchema.name];
                  }
                  return result;
                }
              }
            }
          }
        }
        if (result.verified === false) {
          const _result = {
            verified: false,
            result: root
          };
          if (inputSchema.name) {
            inputSchema.name = inputSchema.name.replace(/^\s+|\s+$/g, EMPTY_STRING);
            if (inputSchema.name) {
              delete root[inputSchema.name];
              _result.name = inputSchema.name;
            }
          }
          return _result;
        }
        return {
          verified: true,
          result: root
        };
      }
      if (inputSchema.primitiveSchema && VALUE_HEX_VIEW in inputData.valueBlock) {
        const asn1 = localFromBER(inputData.valueBlock.valueHexView);
        if (asn1.offset === -1) {
          const _result = {
            verified: false,
            result: asn1.result
          };
          if (inputSchema.name) {
            inputSchema.name = inputSchema.name.replace(/^\s+|\s+$/g, EMPTY_STRING);
            if (inputSchema.name) {
              delete root[inputSchema.name];
              _result.name = inputSchema.name;
            }
          }
          return _result;
        }
        return compareSchema(root, asn1.result, inputSchema.primitiveSchema);
      }
      return {
        verified: true,
        result: root
      };
    }
    function verifySchema(inputBuffer, inputSchema) {
      if (inputSchema instanceof Object === false) {
        return {
          verified: false,
          result: { error: "Wrong ASN.1 schema type" }
        };
      }
      const asn1 = localFromBER(pvtsutils__namespace.BufferSourceConverter.toUint8Array(inputBuffer));
      if (asn1.offset === -1) {
        return {
          verified: false,
          result: asn1.result
        };
      }
      return compareSchema(asn1.result, asn1.result, inputSchema);
    }
    exports.Any = Any;
    exports.BaseBlock = BaseBlock;
    exports.BaseStringBlock = BaseStringBlock;
    exports.BitString = BitString;
    exports.BmpString = BmpString;
    exports.Boolean = Boolean2;
    exports.CharacterString = CharacterString;
    exports.Choice = Choice;
    exports.Constructed = Constructed;
    exports.DATE = DATE;
    exports.DEFAULT_MAX_CONTENT_LENGTH = DEFAULT_MAX_CONTENT_LENGTH;
    exports.DEFAULT_MAX_DEPTH = DEFAULT_MAX_DEPTH;
    exports.DEFAULT_MAX_NODES = DEFAULT_MAX_NODES;
    exports.DateTime = DateTime;
    exports.Duration = Duration;
    exports.EndOfContent = EndOfContent;
    exports.Enumerated = Enumerated;
    exports.GeneralString = GeneralString;
    exports.GeneralizedTime = GeneralizedTime;
    exports.GraphicString = GraphicString;
    exports.HexBlock = HexBlock;
    exports.IA5String = IA5String;
    exports.Integer = Integer;
    exports.Null = Null;
    exports.NumericString = NumericString;
    exports.ObjectIdentifier = ObjectIdentifier;
    exports.OctetString = OctetString;
    exports.Primitive = Primitive;
    exports.PrintableString = PrintableString;
    exports.RawData = RawData;
    exports.RelativeObjectIdentifier = RelativeObjectIdentifier;
    exports.Repeated = Repeated;
    exports.Sequence = Sequence;
    exports.Set = Set2;
    exports.TIME = TIME;
    exports.TeletexString = TeletexString;
    exports.TimeOfDay = TimeOfDay;
    exports.UTCTime = UTCTime;
    exports.UniversalString = UniversalString;
    exports.Utf8String = Utf8String;
    exports.ValueBlock = ValueBlock;
    exports.VideotexString = VideotexString;
    exports.ViewWriter = ViewWriter;
    exports.VisibleString = VisibleString;
    exports.compareSchema = compareSchema;
    exports.fromBER = fromBER;
    exports.verifySchema = verifySchema;
  }
});

// node_modules/@peculiar/utils/build/cjs/bytes/buffer-source.js
var require_buffer_source = __commonJS({
  "node_modules/@peculiar/utils/build/cjs/bytes/buffer-source.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.isArrayBuffer = isArrayBuffer;
    exports.isSharedArrayBuffer = isSharedArrayBuffer;
    exports.isArrayBufferLike = isArrayBufferLike;
    exports.isArrayBufferView = isArrayBufferView;
    exports.isBufferSource = isBufferSource;
    exports.assertBufferSource = assertBufferSource;
    exports.toUint8Array = toUint8Array;
    exports.toUint8ArrayCopy = toUint8ArrayCopy;
    exports.toArrayBuffer = toArrayBuffer;
    exports.toArrayBufferLike = toArrayBufferLike;
    exports.toView = toView;
    exports.toViewCopy = toViewCopy;
    var ARRAY_BUFFER_TAG = "[object ArrayBuffer]";
    var SHARED_ARRAY_BUFFER_TAG = "[object SharedArrayBuffer]";
    function tagOf(value) {
      return Object.prototype.toString.call(value);
    }
    function isDataViewConstructor(type) {
      return type === DataView || type.prototype instanceof DataView;
    }
    function bytesPerElement(type) {
      if (isDataViewConstructor(type)) {
        return 1;
      }
      const value = type.BYTES_PER_ELEMENT;
      return value ?? 1;
    }
    function isArrayBufferViewLike(value) {
      if (ArrayBuffer.isView(value)) {
        return true;
      }
      if (!value || typeof value !== "object") {
        return false;
      }
      const view = value;
      return typeof view.byteOffset === "number" && typeof view.byteLength === "number" && isArrayBufferLike(view.buffer);
    }
    function copyBytes(data) {
      const view = toUint8Array(data);
      const copy = new Uint8Array(view.byteLength);
      copy.set(view);
      return copy;
    }
    function isArrayBuffer(value) {
      return tagOf(value) === ARRAY_BUFFER_TAG;
    }
    function isSharedArrayBuffer(value) {
      return typeof SharedArrayBuffer !== "undefined" && tagOf(value) === SHARED_ARRAY_BUFFER_TAG;
    }
    function isArrayBufferLike(value) {
      return isArrayBuffer(value) || isSharedArrayBuffer(value);
    }
    function isArrayBufferView(value) {
      return isArrayBufferViewLike(value);
    }
    function isBufferSource(value) {
      return isArrayBufferLike(value) || isArrayBufferView(value);
    }
    function assertBufferSource(value) {
      if (!isBufferSource(value)) {
        throw new TypeError("Expected ArrayBuffer, SharedArrayBuffer, or ArrayBufferView");
      }
    }
    function toUint8Array(data) {
      assertBufferSource(data);
      if (isArrayBufferLike(data)) {
        return new Uint8Array(data);
      }
      return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    }
    function toUint8ArrayCopy(data) {
      return copyBytes(data);
    }
    function toArrayBuffer(data) {
      assertBufferSource(data);
      if (isArrayBuffer(data)) {
        return data;
      }
      const buffer = new ArrayBuffer(data.byteLength);
      new Uint8Array(buffer).set(toUint8Array(data));
      return buffer;
    }
    function toArrayBufferLike(data) {
      assertBufferSource(data);
      if (isArrayBufferLike(data)) {
        return data;
      }
      if (data.byteOffset === 0 && data.byteLength === data.buffer.byteLength) {
        return data.buffer;
      }
      return copyBytes(data).buffer;
    }
    function toView(data, type) {
      assertBufferSource(data);
      if (ArrayBuffer.isView(data) && data.constructor === type) {
        return data;
      }
      const view = toUint8Array(data);
      const elementSize = bytesPerElement(type);
      if (view.byteOffset % elementSize !== 0 || view.byteLength % elementSize !== 0) {
        throw new RangeError(`Cannot create ${type.name} over unaligned byte range`);
      }
      if (isDataViewConstructor(type)) {
        return new type(view.buffer, view.byteOffset, view.byteLength);
      }
      return new type(view.buffer, view.byteOffset, view.byteLength / elementSize);
    }
    function toViewCopy(data, type) {
      const copy = toUint8ArrayCopy(data);
      return toView(copy, type);
    }
  }
});

// node_modules/@peculiar/utils/build/cjs/bytes/concat.js
var require_concat = __commonJS({
  "node_modules/@peculiar/utils/build/cjs/bytes/concat.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.concatToUint8Array = concatToUint8Array;
    exports.concat = concat;
    var buffer_source_js_1 = require_buffer_source();
    function concatToUint8Array(buffers) {
      const views = [];
      let length = 0;
      for (const buffer of buffers) {
        const view = (0, buffer_source_js_1.toUint8Array)(buffer);
        views.push(view);
        length += view.byteLength;
      }
      const result = new Uint8Array(length);
      let offset = 0;
      for (const view of views) {
        result.set(view, offset);
        offset += view.byteLength;
      }
      return result;
    }
    function concat(first, second, ...rest) {
      let buffers;
      let type;
      if (typeof second === "function") {
        buffers = Array.from(first);
        type = second;
      } else if ((0, buffer_source_js_1.isBufferSource)(first)) {
        buffers = [first, second, ...rest].filter(buffer_source_js_1.isBufferSource);
      } else {
        buffers = Array.from(first);
        if (second) {
          buffers.push(second);
        }
        buffers.push(...rest);
      }
      const bytes = concatToUint8Array(buffers);
      return type ? (0, buffer_source_js_1.toView)(bytes, type) : bytes.buffer;
    }
  }
});

// node_modules/@peculiar/utils/build/cjs/bytes/equal.js
var require_equal = __commonJS({
  "node_modules/@peculiar/utils/build/cjs/bytes/equal.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.equal = equal;
    var buffer_source_js_1 = require_buffer_source();
    function equal(a, b, options = {}) {
      const left = (0, buffer_source_js_1.toUint8Array)(a);
      const right = (0, buffer_source_js_1.toUint8Array)(b);
      if (!options.constantTime && left.byteLength !== right.byteLength) {
        return false;
      }
      const length = Math.max(left.byteLength, right.byteLength);
      let diff = left.byteLength ^ right.byteLength;
      for (let i = 0; i < length; i++) {
        diff |= (left[i] ?? 0) ^ (right[i] ?? 0);
      }
      return diff === 0;
    }
  }
});

// node_modules/@peculiar/utils/build/cjs/bytes/sequence.js
var require_sequence = __commonJS({
  "node_modules/@peculiar/utils/build/cjs/bytes/sequence.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.indexOf = indexOf;
    exports.lastIndexOf = lastIndexOf;
    exports.includes = includes;
    exports.startsWith = startsWith;
    exports.endsWith = endsWith;
    exports.slice = slice;
    exports.tail = tail;
    exports.copy = copy;
    exports.compare = compare;
    var buffer_source_js_1 = require_buffer_source();
    function clampIndex(value, fallback, length) {
      const normalized = Number.isFinite(value) ? Math.trunc(value) : fallback;
      if (normalized <= 0) {
        return 0;
      }
      if (normalized >= length) {
        return length;
      }
      return normalized;
    }
    function normalizeForwardRange(length, options) {
      const start = clampIndex(options?.start, 0, length);
      const end = clampIndex(options?.end, length, length);
      return end >= start ? [start, end] : [start, start];
    }
    function normalizeReverseRange(length, options) {
      const start = clampIndex(options?.start, length, length);
      const end = clampIndex(options?.end, 0, length);
      return start >= end ? [end, start] : [start, start];
    }
    function normalizeSliceIndex(value, fallback, length) {
      const normalized = Number.isFinite(value) ? Math.trunc(value) : fallback;
      if (normalized < 0) {
        return Math.max(length + normalized, 0);
      }
      if (normalized > length) {
        return length;
      }
      return normalized;
    }
    function encodeAscii(text) {
      const bytes = new Uint8Array(text.length);
      for (let i = 0; i < text.length; i++) {
        bytes[i] = text.charCodeAt(i) & 255;
      }
      return bytes;
    }
    function encodeUtf8(text) {
      return new TextEncoder().encode(text);
    }
    function toPatternBytes(pattern, options) {
      if (typeof pattern === "string") {
        return options?.encoding === "utf8" ? encodeUtf8(pattern) : encodeAscii(pattern);
      }
      return (0, buffer_source_js_1.toUint8Array)(pattern);
    }
    function bytesEqualAt(data, pattern, offset) {
      for (let index = 0; index < pattern.byteLength; index++) {
        if (data[offset + index] !== pattern[index]) {
          return false;
        }
      }
      return true;
    }
    function indexOf(data, pattern, options) {
      const bytes = (0, buffer_source_js_1.toUint8Array)(data);
      const needle = toPatternBytes(pattern, options);
      const [start, end] = normalizeForwardRange(bytes.byteLength, options);
      if (needle.byteLength === 0) {
        return start;
      }
      const lastOffset = end - needle.byteLength;
      if (lastOffset < start) {
        return -1;
      }
      for (let offset = start; offset <= lastOffset; offset++) {
        if (bytesEqualAt(bytes, needle, offset)) {
          return offset;
        }
      }
      return -1;
    }
    function lastIndexOf(data, pattern, options) {
      const bytes = (0, buffer_source_js_1.toUint8Array)(data);
      const needle = toPatternBytes(pattern, options);
      const [end, start] = normalizeReverseRange(bytes.byteLength, options);
      if (needle.byteLength === 0) {
        return start;
      }
      const firstOffset = start - needle.byteLength;
      if (firstOffset < end) {
        return -1;
      }
      for (let offset = firstOffset; offset >= end; offset--) {
        if (bytesEqualAt(bytes, needle, offset)) {
          return offset;
        }
      }
      return -1;
    }
    function includes(data, pattern, options) {
      return indexOf(data, pattern, options) !== -1;
    }
    function startsWith(data, pattern, options) {
      const bytes = (0, buffer_source_js_1.toUint8Array)(data);
      const needle = toPatternBytes(pattern, options);
      if (needle.byteLength > bytes.byteLength) {
        return false;
      }
      return bytesEqualAt(bytes, needle, 0);
    }
    function endsWith(data, pattern, options) {
      const bytes = (0, buffer_source_js_1.toUint8Array)(data);
      const needle = toPatternBytes(pattern, options);
      if (needle.byteLength > bytes.byteLength) {
        return false;
      }
      return bytesEqualAt(bytes, needle, bytes.byteLength - needle.byteLength);
    }
    function slice(data, start, end) {
      const bytes = (0, buffer_source_js_1.toUint8Array)(data);
      const normalizedStart = normalizeSliceIndex(start, 0, bytes.byteLength);
      const normalizedEnd = normalizeSliceIndex(end, bytes.byteLength, bytes.byteLength);
      if (normalizedEnd <= normalizedStart) {
        return bytes.subarray(normalizedStart, normalizedStart);
      }
      return bytes.subarray(normalizedStart, normalizedEnd);
    }
    function tail(data, length) {
      const bytes = (0, buffer_source_js_1.toUint8Array)(data);
      const normalizedLength = Number.isFinite(length) ? Math.max(0, Math.trunc(length)) : 0;
      if (normalizedLength >= bytes.byteLength) {
        return bytes;
      }
      return bytes.subarray(bytes.byteLength - normalizedLength);
    }
    function copy(data) {
      return (0, buffer_source_js_1.toUint8ArrayCopy)(data);
    }
    function compare(a, b) {
      const left = (0, buffer_source_js_1.toUint8Array)(a);
      const right = (0, buffer_source_js_1.toUint8Array)(b);
      const limit = Math.min(left.byteLength, right.byteLength);
      for (let index = 0; index < limit; index++) {
        if (left[index] < right[index]) {
          return -1;
        }
        if (left[index] > right[index]) {
          return 1;
        }
      }
      if (left.byteLength < right.byteLength) {
        return -1;
      }
      if (left.byteLength > right.byteLength) {
        return 1;
      }
      return 0;
    }
  }
});

// node_modules/@peculiar/utils/build/cjs/bytes/index.js
var require_bytes = __commonJS({
  "node_modules/@peculiar/utils/build/cjs/bytes/index.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.tail = exports.startsWith = exports.slice = exports.lastIndexOf = exports.indexOf = exports.includes = exports.endsWith = exports.copy = exports.compare = exports.equal = exports.concatToUint8Array = exports.concat = exports.toViewCopy = exports.toView = exports.toUint8ArrayCopy = exports.toUint8Array = exports.toArrayBufferLike = exports.toArrayBuffer = exports.isSharedArrayBuffer = exports.isBufferSource = exports.isArrayBufferView = exports.isArrayBufferLike = exports.isArrayBuffer = exports.assertBufferSource = void 0;
    var buffer_source_js_1 = require_buffer_source();
    Object.defineProperty(exports, "assertBufferSource", { enumerable: true, get: function() {
      return buffer_source_js_1.assertBufferSource;
    } });
    Object.defineProperty(exports, "isArrayBuffer", { enumerable: true, get: function() {
      return buffer_source_js_1.isArrayBuffer;
    } });
    Object.defineProperty(exports, "isArrayBufferLike", { enumerable: true, get: function() {
      return buffer_source_js_1.isArrayBufferLike;
    } });
    Object.defineProperty(exports, "isArrayBufferView", { enumerable: true, get: function() {
      return buffer_source_js_1.isArrayBufferView;
    } });
    Object.defineProperty(exports, "isBufferSource", { enumerable: true, get: function() {
      return buffer_source_js_1.isBufferSource;
    } });
    Object.defineProperty(exports, "isSharedArrayBuffer", { enumerable: true, get: function() {
      return buffer_source_js_1.isSharedArrayBuffer;
    } });
    Object.defineProperty(exports, "toArrayBuffer", { enumerable: true, get: function() {
      return buffer_source_js_1.toArrayBuffer;
    } });
    Object.defineProperty(exports, "toArrayBufferLike", { enumerable: true, get: function() {
      return buffer_source_js_1.toArrayBufferLike;
    } });
    Object.defineProperty(exports, "toUint8Array", { enumerable: true, get: function() {
      return buffer_source_js_1.toUint8Array;
    } });
    Object.defineProperty(exports, "toUint8ArrayCopy", { enumerable: true, get: function() {
      return buffer_source_js_1.toUint8ArrayCopy;
    } });
    Object.defineProperty(exports, "toView", { enumerable: true, get: function() {
      return buffer_source_js_1.toView;
    } });
    Object.defineProperty(exports, "toViewCopy", { enumerable: true, get: function() {
      return buffer_source_js_1.toViewCopy;
    } });
    var concat_js_1 = require_concat();
    Object.defineProperty(exports, "concat", { enumerable: true, get: function() {
      return concat_js_1.concat;
    } });
    Object.defineProperty(exports, "concatToUint8Array", { enumerable: true, get: function() {
      return concat_js_1.concatToUint8Array;
    } });
    var equal_js_1 = require_equal();
    Object.defineProperty(exports, "equal", { enumerable: true, get: function() {
      return equal_js_1.equal;
    } });
    var sequence_js_1 = require_sequence();
    Object.defineProperty(exports, "compare", { enumerable: true, get: function() {
      return sequence_js_1.compare;
    } });
    Object.defineProperty(exports, "copy", { enumerable: true, get: function() {
      return sequence_js_1.copy;
    } });
    Object.defineProperty(exports, "endsWith", { enumerable: true, get: function() {
      return sequence_js_1.endsWith;
    } });
    Object.defineProperty(exports, "includes", { enumerable: true, get: function() {
      return sequence_js_1.includes;
    } });
    Object.defineProperty(exports, "indexOf", { enumerable: true, get: function() {
      return sequence_js_1.indexOf;
    } });
    Object.defineProperty(exports, "lastIndexOf", { enumerable: true, get: function() {
      return sequence_js_1.lastIndexOf;
    } });
    Object.defineProperty(exports, "slice", { enumerable: true, get: function() {
      return sequence_js_1.slice;
    } });
    Object.defineProperty(exports, "startsWith", { enumerable: true, get: function() {
      return sequence_js_1.startsWith;
    } });
    Object.defineProperty(exports, "tail", { enumerable: true, get: function() {
      return sequence_js_1.tail;
    } });
  }
});

// node_modules/@peculiar/utils/build/cjs/encoding/binary.js
var require_binary = __commonJS({
  "node_modules/@peculiar/utils/build/cjs/encoding/binary.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.binary = void 0;
    exports.encode = encode;
    exports.decode = decode;
    exports.is = is;
    var index_js_1 = require_bytes();
    function encode(data) {
      const bytes = (0, index_js_1.toUint8Array)(data);
      let result = "";
      for (const byte of bytes) {
        result += String.fromCharCode(byte);
      }
      return result;
    }
    function decode(text) {
      const result = new Uint8Array(text.length);
      for (let i = 0; i < text.length; i++) {
        result[i] = text.charCodeAt(i) & 255;
      }
      return result;
    }
    function is(text) {
      return typeof text === "string";
    }
    exports.binary = { encode, decode, is };
  }
});

// node_modules/@peculiar/utils/build/cjs/encoding/hex.js
var require_hex = __commonJS({
  "node_modules/@peculiar/utils/build/cjs/encoding/hex.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.hex = exports.formats = void 0;
    exports.normalize = normalize;
    exports.is = is;
    exports.encode = encode;
    exports.decode = decode;
    exports.parse = parse2;
    exports.format = format;
    var index_js_1 = require_bytes();
    var HEX_CHARACTER_REGEX = /^[0-9a-f]$/i;
    var COMMON_SEPARATORS = [" ", "	", "\n", "\r", ":", "-", "."];
    function resolveSeparators(options) {
      if (options.separators === "none") {
        return [];
      }
      if (!options.separators || options.separators === "common") {
        return COMMON_SEPARATORS;
      }
      return options.separators;
    }
    function validateSeparator(separator) {
      if (!separator) {
        throw new TypeError("Hex separators must be non-empty strings");
      }
    }
    function matchSeparator(text, index, separators) {
      for (const separator of separators) {
        if (text.startsWith(separator, index)) {
          return separator;
        }
      }
      return void 0;
    }
    function detectCase(text) {
      const hasUpper = /[A-F]/.test(text);
      const hasLower = /[a-f]/.test(text);
      return hasUpper && !hasLower ? "upper" : "lower";
    }
    function detectLineSeparator(text) {
      const match = /\r\n|\n/.exec(text);
      if (!match) {
        return void 0;
      }
      return match[0] === "\r\n" ? "\r\n" : "\n";
    }
    function compactForDetection(text) {
      return text.replace(/[^0-9a-f]/gi, "");
    }
    function detectGroup(text) {
      const segments = text.match(/[0-9A-Fa-f]+|[^0-9A-Fa-f]+/g) ?? [];
      if (segments.length < 3) {
        return void 0;
      }
      const hexSegments = segments.filter((_, index) => index % 2 === 0);
      const separators = segments.filter((_, index) => index % 2 === 1);
      const separator = separators[0];
      if (!separator || separators.some((item) => item !== separator)) {
        return void 0;
      }
      if (hexSegments.some((segment) => segment.length === 0 || segment.length % 2 !== 0)) {
        return void 0;
      }
      const firstLength = hexSegments[0]?.length ?? 0;
      if (!firstLength) {
        return void 0;
      }
      if (hexSegments.slice(0, -1).some((segment) => segment.length !== firstLength)) {
        return void 0;
      }
      if ((hexSegments[hexSegments.length - 1]?.length ?? 0) > firstLength) {
        return void 0;
      }
      return {
        size: firstLength / 2,
        separator
      };
    }
    function detectFormat(text) {
      const trimmed = text.trim();
      const prefix = /^0x/i.test(trimmed) ? "0x" : "";
      const body = prefix ? trimmed.slice(2) : trimmed;
      const lineSeparator = detectLineSeparator(body);
      const lines = body.split(/\r\n|\n/).filter((line) => line.length > 0);
      const sampleLine = lines[0]?.trim() ?? "";
      const group = detectGroup(sampleLine);
      const format2 = {
        case: detectCase(trimmed),
        prefix
      };
      if (group) {
        format2.group = group;
      }
      if (lineSeparator && lines.length > 1) {
        const firstLineBytes = compactForDetection(lines[0] ?? "").length / 2;
        if (firstLineBytes > 0 && lines.slice(0, -1).every((line) => compactForDetection(line).length / 2 === firstLineBytes)) {
          format2.line = {
            bytesPerLine: firstLineBytes,
            separator: lineSeparator
          };
        }
      }
      return format2;
    }
    function normalizeText(text, options) {
      const allowPrefix = options.allowPrefix ?? true;
      const separators = [...resolveSeparators(options)].sort((left, right) => right.length - left.length);
      for (const separator of separators) {
        validateSeparator(separator);
      }
      let working = text.trim();
      if (/^0x/i.test(working)) {
        if (!allowPrefix) {
          throw new TypeError("Hexadecimal text must not include a 0x prefix");
        }
        working = working.slice(2);
      }
      let normalized = "";
      let lastTokenWasSeparator = false;
      for (let index = 0; index < working.length; ) {
        const character = working[index] ?? "";
        if (HEX_CHARACTER_REGEX.test(character)) {
          normalized += character;
          lastTokenWasSeparator = false;
          index += 1;
          continue;
        }
        const separator = matchSeparator(working, index, separators);
        if (!separator) {
          throw new TypeError("Input is not valid hexadecimal text");
        }
        if (options.strict && (lastTokenWasSeparator || normalized.length === 0)) {
          throw new TypeError("Hexadecimal text contains misplaced separators");
        }
        lastTokenWasSeparator = true;
        index += separator.length;
      }
      if (options.strict && lastTokenWasSeparator && normalized.length > 0) {
        throw new TypeError("Hexadecimal text must not end with a separator");
      }
      if (normalized.length % 2 !== 0) {
        if (!options.allowOddLength) {
          throw new TypeError("Hexadecimal text must contain an even number of characters");
        }
        normalized = `0${normalized}`;
      }
      return normalized.toLowerCase();
    }
    function groupPairs(pairs, group) {
      if (!group) {
        return pairs.join("");
      }
      if (!Number.isInteger(group.size) || group.size < 1) {
        throw new RangeError("Hex group size must be a positive integer");
      }
      const chunks = [];
      for (let index = 0; index < pairs.length; index += group.size) {
        chunks.push(pairs.slice(index, index + group.size).join(""));
      }
      return chunks.join(group.separator);
    }
    function normalize(text, options = {}) {
      return normalizeText(text, options);
    }
    function is(text, options = {}) {
      if (typeof text !== "string") {
        return false;
      }
      try {
        normalize(text, options);
        return true;
      } catch {
        return false;
      }
    }
    function encode(data, options = {}) {
      const bytes = (0, index_js_1.toUint8Array)(data);
      const casing = options.case ?? "lower";
      const pairs = Array.from(bytes, (byte) => {
        const text = byte.toString(16).padStart(2, "0");
        return casing === "upper" ? text.toUpperCase() : text;
      });
      let body = "";
      if (options.line) {
        const bytesPerLine = options.line.bytesPerLine;
        if (!Number.isInteger(bytesPerLine) || bytesPerLine < 1) {
          throw new RangeError("Hex bytesPerLine must be a positive integer");
        }
        const separator = options.line.separator ?? "\n";
        const lines = [];
        for (let index = 0; index < pairs.length; index += bytesPerLine) {
          lines.push(groupPairs(pairs.slice(index, index + bytesPerLine), options.group));
        }
        body = lines.join(separator);
      } else {
        body = groupPairs(pairs, options.group);
      }
      return `${options.prefix ?? ""}${body}`;
    }
    function decode(text, options = {}) {
      const normalized = normalize(text, options);
      const result = new Uint8Array(normalized.length / 2);
      for (let i = 0; i < normalized.length; i += 2) {
        result[i / 2] = Number.parseInt(normalized.slice(i, i + 2), 16);
      }
      return result;
    }
    function parse2(text, options = {}) {
      const normalized = normalize(text, options);
      return {
        bytes: decode(normalized),
        format: detectFormat(text),
        normalized
      };
    }
    function format(data, value) {
      return encode(data, value);
    }
    exports.formats = {
      compact: Object.freeze({}),
      upper: Object.freeze({ case: "upper" }),
      colon: Object.freeze({ group: { size: 1, separator: ":" } }),
      colonUpper: Object.freeze({ case: "upper", group: { size: 1, separator: ":" } }),
      groupsOf4: Object.freeze({ group: { size: 4, separator: " " } }),
      prefixed: Object.freeze({ prefix: "0x" })
    };
    exports.hex = { encode, decode, format, formats: exports.formats, is, normalize, parse: parse2 };
  }
});

// node_modules/@peculiar/utils/build/cjs/encoding/utf8.js
var require_utf8 = __commonJS({
  "node_modules/@peculiar/utils/build/cjs/encoding/utf8.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.utf8 = void 0;
    exports.encode = encode;
    exports.decode = decode;
    var index_js_1 = require_bytes();
    function encode(text) {
      return new TextEncoder().encode(text);
    }
    function decode(data) {
      return new TextDecoder("utf-8", { fatal: false }).decode((0, index_js_1.toUint8Array)(data));
    }
    exports.utf8 = { encode, decode };
  }
});

// node_modules/@peculiar/utils/build/cjs/encoding/utf16.js
var require_utf16 = __commonJS({
  "node_modules/@peculiar/utils/build/cjs/encoding/utf16.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.utf16 = void 0;
    exports.encode = encode;
    exports.decode = decode;
    var index_js_1 = require_bytes();
    function encode(text, options = {}) {
      const result = new ArrayBuffer(text.length * 2);
      const view = new DataView(result);
      for (let i = 0; i < text.length; i++) {
        view.setUint16(i * 2, text.charCodeAt(i), options.littleEndian ?? false);
      }
      return new Uint8Array(result);
    }
    function decode(data, options = {}) {
      const buffer = (0, index_js_1.toArrayBuffer)(data);
      const view = new DataView(buffer);
      let result = "";
      for (let i = 0; i < buffer.byteLength; i += 2) {
        result += String.fromCharCode(view.getUint16(i, options.littleEndian ?? false));
      }
      return result;
    }
    exports.utf16 = { encode, decode };
  }
});

// node_modules/@peculiar/utils/build/cjs/encoding/base64.js
var require_base64 = __commonJS({
  "node_modules/@peculiar/utils/build/cjs/encoding/base64.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.base64 = void 0;
    exports.normalize = normalize;
    exports.pad = pad;
    exports.is = is;
    exports.encode = encode;
    exports.decode = decode;
    var index_js_1 = require_bytes();
    var binary_js_1 = require_binary();
    var BASE64_REGEX = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
    function nodeBuffer() {
      return globalThis.Buffer;
    }
    function normalize(text) {
      return text.replace(/[\n\r\t ]/g, "");
    }
    function pad(text) {
      const remainder = text.length % 4;
      return remainder ? text + "=".repeat(4 - remainder) : text;
    }
    function is(text) {
      if (typeof text !== "string") {
        return false;
      }
      const normalized = normalize(text);
      return normalized === "" || BASE64_REGEX.test(normalized);
    }
    function encode(data, _options) {
      const bytes = (0, index_js_1.toUint8Array)(data);
      const buffer = nodeBuffer();
      if (buffer) {
        return buffer.from(bytes).toString("base64");
      }
      return btoa((0, binary_js_1.encode)(bytes));
    }
    function decode(text, _options) {
      const normalized = normalize(text);
      if (!is(normalized)) {
        throw new TypeError("Input is not valid Base64 text");
      }
      const buffer = nodeBuffer();
      if (buffer) {
        return new Uint8Array(buffer.from(normalized, "base64"));
      }
      return (0, binary_js_1.decode)(atob(normalized));
    }
    exports.base64 = { encode, decode, is, normalize, pad };
  }
});

// node_modules/@peculiar/utils/build/cjs/encoding/base64url.js
var require_base64url = __commonJS({
  "node_modules/@peculiar/utils/build/cjs/encoding/base64url.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.base64url = void 0;
    exports.normalize = normalize;
    exports.is = is;
    exports.encode = encode;
    exports.decode = decode;
    var base64_js_1 = require_base64();
    var BASE64URL_REGEX = /^[A-Za-z0-9_-]*$/;
    function normalize(text) {
      return text.replace(/[\n\r\t ]/g, "");
    }
    function is(text) {
      return typeof text === "string" && BASE64URL_REGEX.test(normalize(text));
    }
    function encode(data, _options) {
      return base64_js_1.base64.encode(data).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
    }
    function decode(text, _options) {
      const normalized = normalize(text);
      if (!is(normalized)) {
        throw new TypeError("Input is not valid Base64Url text");
      }
      return base64_js_1.base64.decode(base64_js_1.base64.pad(normalized.replace(/-/g, "+").replace(/_/g, "/")));
    }
    exports.base64url = { encode, decode, is, normalize };
  }
});

// node_modules/@peculiar/utils/build/cjs/encoding/index.js
var require_encoding = __commonJS({
  "node_modules/@peculiar/utils/build/cjs/encoding/index.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.base64url = exports.base64 = exports.utf16 = exports.utf8 = exports.hex = exports.binary = void 0;
    var tslib_1 = (init_tslib_es6(), __toCommonJS(tslib_es6_exports));
    exports.binary = tslib_1.__importStar(require_binary());
    exports.hex = tslib_1.__importStar(require_hex());
    exports.utf8 = tslib_1.__importStar(require_utf8());
    exports.utf16 = tslib_1.__importStar(require_utf16());
    exports.base64 = tslib_1.__importStar(require_base64());
    exports.base64url = tslib_1.__importStar(require_base64url());
  }
});

// node_modules/@peculiar/utils/build/cjs/pem/pem.js
var require_pem = __commonJS({
  "node_modules/@peculiar/utils/build/cjs/pem/pem.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.pemConverter = exports.pem = void 0;
    exports.encode = encode;
    exports.encodeMany = encodeMany;
    exports.decode = decode;
    exports.find = find;
    exports.findAll = findAll;
    exports.decodeFirst = decodeFirst;
    exports.parse = parse2;
    exports.format = format;
    var base64_js_1 = require_base64();
    var LABEL_REGEX = /^[A-Z0-9][A-Z0-9 ._-]*[A-Z0-9]$/i;
    var PEM_BLOCK_REGEX = /-----BEGIN ([^-]+)-----([\s\S]*?)-----END \1-----/g;
    function assertLabel(label) {
      if (!LABEL_REGEX.test(label)) {
        throw new TypeError(`Invalid PEM label '${label}'`);
      }
    }
    function wrap(text, lineLength) {
      const result = [];
      for (let i = 0; i < text.length; i += lineLength) {
        result.push(text.slice(i, i + lineLength));
      }
      return result;
    }
    function parseBody(body) {
      const normalized = body.trim().replace(/\r\n/g, "\n");
      const lines = normalized.split("\n").map((line) => line.trim()).filter(Boolean);
      const headers = {};
      let index = 0;
      for (; index < lines.length; index++) {
        const line = lines[index];
        const separator = line.indexOf(":");
        if (separator <= 0) {
          break;
        }
        headers[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
      }
      return {
        headers: Object.keys(headers).length ? headers : void 0,
        base64Lines: lines.slice(index),
        base64Text: lines.slice(index).join("")
      };
    }
    function detectNewline(text) {
      return /\r\n/.test(text) ? "\r\n" : "\n";
    }
    function collectBlocks(text, options = {}) {
      const blocks = [];
      const requestedLabel = options.label;
      let match;
      PEM_BLOCK_REGEX.lastIndex = 0;
      while (match = PEM_BLOCK_REGEX.exec(text)) {
        const label = match[1].trim();
        if (requestedLabel && label !== requestedLabel) {
          continue;
        }
        assertLabel(label);
        const parsed = parseBody(match[2]);
        blocks.push({
          label,
          data: base64_js_1.base64.decode(parsed.base64Text),
          headers: parsed.headers,
          lineLength: parsed.base64Lines[0]?.length ?? 64,
          newline: detectNewline(match[0])
        });
      }
      if (options.strict && blocks.length === 0) {
        throw new TypeError(requestedLabel ? `No PEM block with label '${requestedLabel}' was found` : "No PEM blocks were found");
      }
      return blocks;
    }
    function encode(label, data, options = {}) {
      assertLabel(label);
      const lineLength = options.lineLength ?? 64;
      if (!Number.isInteger(lineLength) || lineLength < 1) {
        throw new RangeError("PEM lineLength must be a positive integer");
      }
      const newline = options.newline ?? "\n";
      const lines = [`-----BEGIN ${label}-----`];
      if (options.headers) {
        for (const [name, value] of Object.entries(options.headers)) {
          lines.push(`${name}: ${value}`);
        }
        lines.push("");
      }
      lines.push(...wrap(base64_js_1.base64.encode(data), lineLength));
      lines.push(`-----END ${label}-----`);
      return `${lines.join(newline)}${newline}`;
    }
    function encodeMany(blocks, options = {}) {
      return blocks.map((block) => encode(block.label, block.data, { ...options, headers: block.headers ?? options.headers })).join("");
    }
    function decode(text, options = {}) {
      return collectBlocks(text, options).map(({ lineLength: _lineLength, newline: _newline, ...block }) => block);
    }
    function find(text, label) {
      return decode(text, { label })[0];
    }
    function findAll(text, label) {
      return decode(text, { label });
    }
    function decodeFirst(text, label) {
      const [block] = decode(text, { label, strict: true });
      return block.data;
    }
    function parse2(text, options = {}) {
      const [block] = collectBlocks(text, { ...options, strict: true });
      const format2 = {
        label: block.label,
        headers: block.headers,
        lineLength: block.lineLength,
        newline: block.newline
      };
      return {
        bytes: block.data,
        format: format2,
        normalized: encode(block.label, block.data, format2)
      };
    }
    function format(data, value) {
      return encode(value.label, data, value);
    }
    exports.pem = { decode, decodeFirst, encode, encodeMany, find, findAll, format, parse: parse2 };
    exports.pemConverter = {
      name: "pem",
      encode: (data, options) => {
        if (!options?.label) {
          throw new TypeError("PEM label is required");
        }
        return encode(options.label, data, options);
      },
      decode: (text, options) => decodeFirst(text, options?.label),
      format,
      is: (text) => typeof text === "string" && /-----BEGIN [^-]+-----/.test(text),
      parse: parse2
    };
  }
});

// node_modules/@peculiar/utils/build/cjs/pem/index.js
var require_pem2 = __commonJS({
  "node_modules/@peculiar/utils/build/cjs/pem/index.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.pemConverter = exports.pem = exports.parse = exports.format = exports.findAll = exports.find = exports.encodeMany = exports.encode = exports.decodeFirst = exports.decode = void 0;
    var pem_js_1 = require_pem();
    Object.defineProperty(exports, "decode", { enumerable: true, get: function() {
      return pem_js_1.decode;
    } });
    Object.defineProperty(exports, "decodeFirst", { enumerable: true, get: function() {
      return pem_js_1.decodeFirst;
    } });
    Object.defineProperty(exports, "encode", { enumerable: true, get: function() {
      return pem_js_1.encode;
    } });
    Object.defineProperty(exports, "encodeMany", { enumerable: true, get: function() {
      return pem_js_1.encodeMany;
    } });
    Object.defineProperty(exports, "find", { enumerable: true, get: function() {
      return pem_js_1.find;
    } });
    Object.defineProperty(exports, "findAll", { enumerable: true, get: function() {
      return pem_js_1.findAll;
    } });
    Object.defineProperty(exports, "format", { enumerable: true, get: function() {
      return pem_js_1.format;
    } });
    Object.defineProperty(exports, "parse", { enumerable: true, get: function() {
      return pem_js_1.parse;
    } });
    Object.defineProperty(exports, "pem", { enumerable: true, get: function() {
      return pem_js_1.pem;
    } });
    Object.defineProperty(exports, "pemConverter", { enumerable: true, get: function() {
      return pem_js_1.pemConverter;
    } });
  }
});

// node_modules/@peculiar/utils/build/cjs/converters/registry.js
var require_registry = __commonJS({
  "node_modules/@peculiar/utils/build/cjs/converters/registry.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.createConverterRegistry = createConverterRegistry;
    function keyOf(name) {
      return name.trim().toLowerCase();
    }
    function toError(error) {
      return error instanceof Error ? error : new Error(String(error));
    }
    function removeConverter(converters, primaryNames, converter) {
      for (const alias of [converter.name, ...converter.aliases ?? []]) {
        converters.delete(keyOf(alias));
      }
      primaryNames.delete(keyOf(converter.name));
    }
    function requireCapability(converter, name, capability) {
      const method = converter[capability];
      if (typeof method !== "function") {
        throw new Error(`Converter '${name}' does not support ${capability}()`);
      }
      return method;
    }
    function detectConfidence(name, text, converter) {
      const normalizedName = keyOf(converter.name || name);
      const trimmed = text.trim();
      if (!trimmed) {
        return 0;
      }
      let accepted = false;
      if (converter.is) {
        accepted = converter.is(text);
      }
      let decodable = false;
      try {
        converter.decode(text);
        decodable = true;
      } catch {
        decodable = false;
      }
      if (!accepted && !decodable) {
        return 0;
      }
      switch (normalizedName) {
        case "pem":
          return /-----BEGIN [^-]+-----/.test(text) ? 1 : 0;
        case "hex": {
          const compact = trimmed.replace(/^0x/i, "").replace(/[\s:.-]/g, "");
          if (!compact || /[^0-9a-f]/i.test(compact) || compact.length % 2 !== 0) {
            return 0;
          }
          if (/^0x/i.test(trimmed) || /[:\s.-]/.test(trimmed)) {
            return 0.95;
          }
          if (/[a-f]/.test(trimmed) || /[A-F]/.test(trimmed)) {
            return 0.8;
          }
          return 0.45;
        }
        case "base64url":
          if (/[-_]/.test(trimmed)) {
            return 0.95;
          }
          if (/=/.test(trimmed)) {
            return 0.1;
          }
          return 0.6;
        case "base64":
          if (/[+/=]/.test(trimmed)) {
            return 0.9;
          }
          return 0.55;
        case "binary":
        case "utf8":
        case "utf16be":
        case "utf16le":
          return 0;
        default:
          return accepted && decodable ? 0.75 : 0.5;
      }
    }
    function createConverterRegistry(initialConverters = []) {
      const converters = /* @__PURE__ */ new Map();
      const primaryNames = /* @__PURE__ */ new Set();
      const api = {
        register(converter, options = {}) {
          if (!converter.name || !keyOf(converter.name)) {
            throw new TypeError("Converter name is required");
          }
          const names = [...new Set([converter.name, ...converter.aliases ?? []].map(keyOf))];
          const conflicts = /* @__PURE__ */ new Set();
          for (const name of names) {
            const existing = converters.get(name);
            if (!existing) {
              continue;
            }
            if (!options.override) {
              throw new Error(`Converter '${name}' is already registered`);
            }
            conflicts.add(existing);
          }
          for (const conflicting of conflicts) {
            removeConverter(converters, primaryNames, conflicting);
          }
          for (const name of names) {
            converters.set(name, converter);
          }
          primaryNames.add(keyOf(converter.name));
          return this;
        },
        unregister(name) {
          const converter = converters.get(keyOf(name));
          if (!converter) {
            return false;
          }
          removeConverter(converters, primaryNames, converter);
          return true;
        },
        has(name) {
          return converters.has(keyOf(name));
        },
        get(name) {
          const converter = converters.get(keyOf(name));
          if (!converter) {
            throw new Error(`Converter '${name}' is not registered`);
          }
          return converter;
        },
        list() {
          return [...primaryNames].map((name) => this.get(name));
        },
        encode(name, data, options) {
          return this.get(name).encode(data, options);
        },
        decode(name, text, options) {
          return this.get(name).decode(text, options);
        },
        tryDecode(name, text, options) {
          try {
            return { ok: true, bytes: this.decode(name, text, options) };
          } catch (error) {
            return { ok: false, error: toError(error) };
          }
        },
        normalize(name, text, options) {
          const converter = this.get(name);
          return requireCapability(converter, name, "normalize").call(converter, text, options);
        },
        parse(name, text, options) {
          const converter = this.get(name);
          return requireCapability(converter, name, "parse").call(converter, text, options);
        },
        format(name, data, format) {
          const converter = this.get(name);
          return requireCapability(converter, name, "format").call(converter, data, format);
        },
        transcode(text, options) {
          const bytes = this.decode(options.from, text, options.fromOptions);
          return this.encode(options.to, bytes, options.toOptions);
        },
        detect(text, options = {}) {
          const formatNames = options.formats?.length ? options.formats.map((name) => String(name)) : this.list().map((converter) => converter.name).filter((name) => !["binary", "utf8", "utf16be", "utf16le"].includes(keyOf(name)));
          const detections = /* @__PURE__ */ new Map();
          for (const requestedName of formatNames) {
            const converter = this.get(requestedName);
            const confidence = detectConfidence(requestedName, text, converter);
            if (confidence <= 0) {
              continue;
            }
            const format = converter.name;
            const current = detections.get(format);
            if (!current || confidence > current.confidence) {
              detections.set(format, { format, confidence });
            }
          }
          return [...detections.values()].sort((left, right) => right.confidence - left.confidence);
        }
      };
      for (const converter of initialConverters) {
        api.register(converter);
      }
      return api;
    }
  }
});

// node_modules/@peculiar/utils/build/cjs/converters/defaults.js
var require_defaults = __commonJS({
  "node_modules/@peculiar/utils/build/cjs/converters/defaults.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.defaultConverterRegistry = exports.defaultConverters = exports.utf16leConverter = exports.utf16beConverter = exports.utf8Converter = exports.base64urlConverter = exports.base64Converter = exports.hexConverter = exports.binaryConverter = exports.pemConverter = void 0;
    var index_js_1 = require_encoding();
    var index_js_2 = require_pem2();
    var index_js_3 = require_pem2();
    Object.defineProperty(exports, "pemConverter", { enumerable: true, get: function() {
      return index_js_3.pemConverter;
    } });
    var registry_js_1 = require_registry();
    exports.binaryConverter = {
      name: "binary",
      aliases: ["latin1"],
      encode: index_js_1.binary.encode,
      decode: index_js_1.binary.decode,
      is: index_js_1.binary.is
    };
    exports.hexConverter = {
      name: "hex",
      encode: index_js_1.hex.encode,
      decode: index_js_1.hex.decode,
      format: index_js_1.hex.format,
      is: index_js_1.hex.is,
      normalize: index_js_1.hex.normalize,
      parse: index_js_1.hex.parse
    };
    exports.base64Converter = {
      name: "base64",
      aliases: ["b64"],
      encode: index_js_1.base64.encode,
      decode: index_js_1.base64.decode,
      is: index_js_1.base64.is,
      normalize: index_js_1.base64.normalize
    };
    exports.base64urlConverter = {
      name: "base64url",
      aliases: ["base64-url", "b64url"],
      encode: index_js_1.base64url.encode,
      decode: index_js_1.base64url.decode,
      is: index_js_1.base64url.is,
      normalize: index_js_1.base64url.normalize
    };
    exports.utf8Converter = {
      name: "utf8",
      aliases: ["utf-8"],
      encode: (data) => index_js_1.utf8.decode(data),
      decode: (text) => index_js_1.utf8.encode(text),
      is: (text) => typeof text === "string"
    };
    exports.utf16beConverter = {
      name: "utf16be",
      aliases: ["utf16", "utf-16", "utf-16be"],
      encode: (data) => index_js_1.utf16.decode(data),
      decode: (text) => index_js_1.utf16.encode(text),
      is: (text) => typeof text === "string"
    };
    exports.utf16leConverter = {
      name: "utf16le",
      aliases: ["utf-16le", "ucs2", "usc2"],
      encode: (data) => index_js_1.utf16.decode(data, { littleEndian: true }),
      decode: (text) => index_js_1.utf16.encode(text, { littleEndian: true }),
      is: (text) => typeof text === "string"
    };
    exports.defaultConverters = [
      exports.binaryConverter,
      exports.hexConverter,
      exports.base64Converter,
      exports.base64urlConverter,
      exports.utf8Converter,
      exports.utf16beConverter,
      exports.utf16leConverter,
      index_js_2.pemConverter
    ];
    exports.defaultConverterRegistry = (0, registry_js_1.createConverterRegistry)(exports.defaultConverters);
  }
});

// node_modules/@peculiar/utils/build/cjs/converters/convert.js
var require_convert = __commonJS({
  "node_modules/@peculiar/utils/build/cjs/converters/convert.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.convert = void 0;
    var index_js_1 = require_bytes();
    var index_js_2 = require_encoding();
    var defaults_js_1 = require_defaults();
    function encode(name, data, ...args) {
      return defaults_js_1.defaultConverterRegistry.encode(name, data, ...args);
    }
    function decode(name, text, ...args) {
      return defaults_js_1.defaultConverterRegistry.decode(name, text, ...args);
    }
    function tryDecode(name, text, ...args) {
      return defaults_js_1.defaultConverterRegistry.tryDecode(name, text, ...args);
    }
    function normalize(name, text, ...args) {
      return defaults_js_1.defaultConverterRegistry.normalize(name, text, ...args);
    }
    function parse2(name, text, ...args) {
      return defaults_js_1.defaultConverterRegistry.parse(name, text, ...args);
    }
    function format(name, data, value) {
      return defaults_js_1.defaultConverterRegistry.format(name, data, value);
    }
    function transcode(text, options) {
      return defaults_js_1.defaultConverterRegistry.transcode(text, options);
    }
    function detect(text, options) {
      return defaults_js_1.defaultConverterRegistry.detect(text, options);
    }
    function normalizeEncodingName(encoding) {
      return encoding.toLowerCase();
    }
    exports.convert = {
      encode,
      decode,
      tryDecode,
      normalize,
      parse: parse2,
      format,
      transcode,
      detect,
      to(format2, data, ...args) {
        return encode(format2, data, ...args);
      },
      from(format2, text, ...args) {
        return decode(format2, text, ...args);
      },
      toString(data, encoding = "utf8") {
        return encode(encoding, data);
      },
      fromString(text, encoding = "utf8") {
        if (normalizeEncodingName(encoding) === "hex") {
          return (0, index_js_1.toArrayBuffer)(index_js_2.hex.decode(text, { allowOddLength: true }));
        }
        return (0, index_js_1.toArrayBuffer)(decode(encoding, text));
      },
      toBase64: index_js_2.base64.encode,
      fromBase64: (text) => (0, index_js_1.toArrayBuffer)(index_js_2.base64.decode(text)),
      toBase64Url: index_js_2.base64url.encode,
      fromBase64Url: (text) => (0, index_js_1.toArrayBuffer)(index_js_2.base64url.decode(text)),
      toHex: index_js_2.hex.encode,
      fromHex: (text) => (0, index_js_1.toArrayBuffer)(index_js_2.hex.decode(text, { allowOddLength: true })),
      toBinary: index_js_2.binary.encode,
      fromBinary: (text) => (0, index_js_1.toArrayBuffer)(index_js_2.binary.decode(text)),
      toUtf8String: index_js_2.utf8.decode,
      fromUtf8String: (text) => (0, index_js_1.toArrayBuffer)(index_js_2.utf8.encode(text)),
      toUtf16String: (data, littleEndian = false) => index_js_2.utf16.decode(data, { littleEndian }),
      fromUtf16String: (text, littleEndian = false) => (0, index_js_1.toArrayBuffer)(index_js_2.utf16.encode(text, { littleEndian })),
      isHex: index_js_2.hex.is,
      isBase64: index_js_2.base64.is,
      isBase64Url: index_js_2.base64url.is,
      formatString: index_js_2.base64.normalize
    };
  }
});

// node_modules/@peculiar/utils/build/cjs/converters/index.js
var require_converters = __commonJS({
  "node_modules/@peculiar/utils/build/cjs/converters/index.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.convert = exports.utf8Converter = exports.utf16leConverter = exports.utf16beConverter = exports.pemConverter = exports.hexConverter = exports.defaultConverters = exports.defaultConverterRegistry = exports.binaryConverter = exports.base64urlConverter = exports.base64Converter = exports.createConverterRegistry = void 0;
    var registry_js_1 = require_registry();
    Object.defineProperty(exports, "createConverterRegistry", { enumerable: true, get: function() {
      return registry_js_1.createConverterRegistry;
    } });
    var defaults_js_1 = require_defaults();
    Object.defineProperty(exports, "base64Converter", { enumerable: true, get: function() {
      return defaults_js_1.base64Converter;
    } });
    Object.defineProperty(exports, "base64urlConverter", { enumerable: true, get: function() {
      return defaults_js_1.base64urlConverter;
    } });
    Object.defineProperty(exports, "binaryConverter", { enumerable: true, get: function() {
      return defaults_js_1.binaryConverter;
    } });
    Object.defineProperty(exports, "defaultConverterRegistry", { enumerable: true, get: function() {
      return defaults_js_1.defaultConverterRegistry;
    } });
    Object.defineProperty(exports, "defaultConverters", { enumerable: true, get: function() {
      return defaults_js_1.defaultConverters;
    } });
    Object.defineProperty(exports, "hexConverter", { enumerable: true, get: function() {
      return defaults_js_1.hexConverter;
    } });
    Object.defineProperty(exports, "pemConverter", { enumerable: true, get: function() {
      return defaults_js_1.pemConverter;
    } });
    Object.defineProperty(exports, "utf16beConverter", { enumerable: true, get: function() {
      return defaults_js_1.utf16beConverter;
    } });
    Object.defineProperty(exports, "utf16leConverter", { enumerable: true, get: function() {
      return defaults_js_1.utf16leConverter;
    } });
    Object.defineProperty(exports, "utf8Converter", { enumerable: true, get: function() {
      return defaults_js_1.utf8Converter;
    } });
    var convert_js_1 = require_convert();
    Object.defineProperty(exports, "convert", { enumerable: true, get: function() {
      return convert_js_1.convert;
    } });
  }
});

// node_modules/@peculiar/utils/build/cjs/legacy/buffer-source-converter.js
var require_buffer_source_converter = __commonJS({
  "node_modules/@peculiar/utils/build/cjs/legacy/buffer-source-converter.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.BufferSourceConverter = void 0;
    var index_js_1 = require_bytes();
    var BufferSourceConverter = class {
      static isArrayBuffer(data) {
        return (0, index_js_1.isArrayBuffer)(data);
      }
      static toArrayBuffer(data) {
        return (0, index_js_1.toArrayBuffer)(data);
      }
      static toUint8Array(data) {
        return (0, index_js_1.toUint8Array)(data);
      }
      static toView(data, type) {
        return (0, index_js_1.toView)(data, type);
      }
      static isBufferSource(data) {
        return (0, index_js_1.isBufferSource)(data);
      }
      static isArrayBufferView(data) {
        return (0, index_js_1.isArrayBufferView)(data);
      }
      static isEqual(a, b) {
        return (0, index_js_1.equal)(a, b);
      }
      static concat(first, second, ...rest) {
        if (Array.isArray(first)) {
          return typeof second === "function" ? (0, index_js_1.concat)(first, second) : (0, index_js_1.concat)(first);
        }
        const buffers = [first, second, ...rest].filter(Boolean);
        return (0, index_js_1.concat)(buffers);
      }
    };
    exports.BufferSourceConverter = BufferSourceConverter;
  }
});

// node_modules/@peculiar/utils/build/cjs/legacy/convert.js
var require_convert2 = __commonJS({
  "node_modules/@peculiar/utils/build/cjs/legacy/convert.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.Convert = void 0;
    var index_js_1 = require_converters();
    function normalizeTextEncoding(encoding) {
      return encoding === "ascii" ? "binary" : encoding;
    }
    var Convert = class _Convert {
      static DEFAULT_UTF8_ENCODING = "utf8";
      static isHex(data) {
        return index_js_1.convert.isHex(data);
      }
      static isBase64(data) {
        return index_js_1.convert.isBase64(data);
      }
      static isBase64Url(data) {
        return index_js_1.convert.isBase64Url(data);
      }
      static ToString(buffer, enc = "utf8") {
        return index_js_1.convert.toString(buffer, enc);
      }
      static FromString(str, enc = "utf8") {
        if (!str) {
          return new ArrayBuffer(0);
        }
        return index_js_1.convert.fromString(str, enc);
      }
      static ToBase64(buffer) {
        return index_js_1.convert.toBase64(buffer);
      }
      static FromBase64(base64) {
        return index_js_1.convert.fromBase64(base64);
      }
      static FromBase64Url(base64url) {
        return index_js_1.convert.fromBase64Url(base64url);
      }
      static ToBase64Url(data) {
        return index_js_1.convert.toBase64Url(data);
      }
      static FromUtf8String(text, encoding = _Convert.DEFAULT_UTF8_ENCODING) {
        return index_js_1.convert.fromString(text, normalizeTextEncoding(encoding));
      }
      static ToUtf8String(buffer, encoding = _Convert.DEFAULT_UTF8_ENCODING) {
        return index_js_1.convert.toString(buffer, normalizeTextEncoding(encoding));
      }
      static FromBinary(text) {
        return index_js_1.convert.fromBinary(text);
      }
      static ToBinary(buffer) {
        return index_js_1.convert.toBinary(buffer);
      }
      static ToHex(buffer) {
        return index_js_1.convert.toHex(buffer);
      }
      static FromHex(hexString) {
        return index_js_1.convert.fromHex(hexString);
      }
      static ToUtf16String(buffer, littleEndian = false) {
        return index_js_1.convert.toUtf16String(buffer, littleEndian);
      }
      static FromUtf16String(text, littleEndian = false) {
        return index_js_1.convert.fromUtf16String(text, littleEndian);
      }
      static Base64Padding(base64) {
        const padCount = 4 - base64.length % 4;
        return padCount < 4 ? base64 + "=".repeat(padCount) : base64;
      }
      static formatString(data) {
        return index_js_1.convert.formatString(data);
      }
    };
    exports.Convert = Convert;
  }
});

// node_modules/@peculiar/utils/build/cjs/legacy/functions.js
var require_functions = __commonJS({
  "node_modules/@peculiar/utils/build/cjs/legacy/functions.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.assign = assign;
    exports.combine = combine;
    exports.isEqual = isEqual;
    var index_js_1 = require_bytes();
    function assign(target, ...sources) {
      for (const source of sources) {
        if (!source) {
          continue;
        }
        for (const prop in source) {
          target[prop] = source[prop];
        }
      }
      return target;
    }
    function combine(...buf) {
      return (0, index_js_1.concat)(buf);
    }
    function isEqual(bytes1, bytes2) {
      return (0, index_js_1.equal)(bytes1, bytes2);
    }
  }
});

// node_modules/@peculiar/utils/build/cjs/legacy/index.js
var require_legacy = __commonJS({
  "node_modules/@peculiar/utils/build/cjs/legacy/index.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.isEqual = exports.combine = exports.assign = exports.Convert = exports.BufferSourceConverter = void 0;
    var buffer_source_converter_js_1 = require_buffer_source_converter();
    Object.defineProperty(exports, "BufferSourceConverter", { enumerable: true, get: function() {
      return buffer_source_converter_js_1.BufferSourceConverter;
    } });
    var convert_js_1 = require_convert2();
    Object.defineProperty(exports, "Convert", { enumerable: true, get: function() {
      return convert_js_1.Convert;
    } });
    var functions_js_1 = require_functions();
    Object.defineProperty(exports, "assign", { enumerable: true, get: function() {
      return functions_js_1.assign;
    } });
    Object.defineProperty(exports, "combine", { enumerable: true, get: function() {
      return functions_js_1.combine;
    } });
    Object.defineProperty(exports, "isEqual", { enumerable: true, get: function() {
      return functions_js_1.isEqual;
    } });
  }
});

// node_modules/@peculiar/utils/build/cjs/index.js
var require_cjs = __commonJS({
  "node_modules/@peculiar/utils/build/cjs/index.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.bytes = void 0;
    var tslib_1 = (init_tslib_es6(), __toCommonJS(tslib_es6_exports));
    tslib_1.__exportStar(require_bytes(), exports);
    exports.bytes = tslib_1.__importStar(require_bytes());
    tslib_1.__exportStar(require_encoding(), exports);
    tslib_1.__exportStar(require_pem2(), exports);
    tslib_1.__exportStar(require_converters(), exports);
    tslib_1.__exportStar(require_legacy(), exports);
  }
});

// node_modules/@peculiar/asn1-schema/build/cjs/enums.js
var require_enums = __commonJS({
  "node_modules/@peculiar/asn1-schema/build/cjs/enums.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.AsnPropTypes = exports.AsnTypeTypes = void 0;
    var AsnTypeTypes;
    (function(AsnTypeTypes2) {
      AsnTypeTypes2[AsnTypeTypes2["Sequence"] = 0] = "Sequence";
      AsnTypeTypes2[AsnTypeTypes2["Set"] = 1] = "Set";
      AsnTypeTypes2[AsnTypeTypes2["Choice"] = 2] = "Choice";
    })(AsnTypeTypes || (exports.AsnTypeTypes = AsnTypeTypes = {}));
    var AsnPropTypes;
    (function(AsnPropTypes2) {
      AsnPropTypes2[AsnPropTypes2["Any"] = 1] = "Any";
      AsnPropTypes2[AsnPropTypes2["Boolean"] = 2] = "Boolean";
      AsnPropTypes2[AsnPropTypes2["OctetString"] = 3] = "OctetString";
      AsnPropTypes2[AsnPropTypes2["BitString"] = 4] = "BitString";
      AsnPropTypes2[AsnPropTypes2["Integer"] = 5] = "Integer";
      AsnPropTypes2[AsnPropTypes2["Enumerated"] = 6] = "Enumerated";
      AsnPropTypes2[AsnPropTypes2["ObjectIdentifier"] = 7] = "ObjectIdentifier";
      AsnPropTypes2[AsnPropTypes2["Utf8String"] = 8] = "Utf8String";
      AsnPropTypes2[AsnPropTypes2["BmpString"] = 9] = "BmpString";
      AsnPropTypes2[AsnPropTypes2["UniversalString"] = 10] = "UniversalString";
      AsnPropTypes2[AsnPropTypes2["NumericString"] = 11] = "NumericString";
      AsnPropTypes2[AsnPropTypes2["PrintableString"] = 12] = "PrintableString";
      AsnPropTypes2[AsnPropTypes2["TeletexString"] = 13] = "TeletexString";
      AsnPropTypes2[AsnPropTypes2["VideotexString"] = 14] = "VideotexString";
      AsnPropTypes2[AsnPropTypes2["IA5String"] = 15] = "IA5String";
      AsnPropTypes2[AsnPropTypes2["GraphicString"] = 16] = "GraphicString";
      AsnPropTypes2[AsnPropTypes2["VisibleString"] = 17] = "VisibleString";
      AsnPropTypes2[AsnPropTypes2["GeneralString"] = 18] = "GeneralString";
      AsnPropTypes2[AsnPropTypes2["CharacterString"] = 19] = "CharacterString";
      AsnPropTypes2[AsnPropTypes2["UTCTime"] = 20] = "UTCTime";
      AsnPropTypes2[AsnPropTypes2["GeneralizedTime"] = 21] = "GeneralizedTime";
      AsnPropTypes2[AsnPropTypes2["DATE"] = 22] = "DATE";
      AsnPropTypes2[AsnPropTypes2["TimeOfDay"] = 23] = "TimeOfDay";
      AsnPropTypes2[AsnPropTypes2["DateTime"] = 24] = "DateTime";
      AsnPropTypes2[AsnPropTypes2["Duration"] = 25] = "Duration";
      AsnPropTypes2[AsnPropTypes2["TIME"] = 26] = "TIME";
      AsnPropTypes2[AsnPropTypes2["Null"] = 27] = "Null";
      AsnPropTypes2[AsnPropTypes2["RelativeObjectIdentifier"] = 28] = "RelativeObjectIdentifier";
    })(AsnPropTypes || (exports.AsnPropTypes = AsnPropTypes = {}));
  }
});

// node_modules/@peculiar/asn1-schema/build/cjs/types/bit_string.js
var require_bit_string = __commonJS({
  "node_modules/@peculiar/asn1-schema/build/cjs/types/bit_string.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.BitString = void 0;
    var tslib_1 = (init_tslib_es6(), __toCommonJS(tslib_es6_exports));
    var asn1js = tslib_1.__importStar(require_build2());
    var utils_1 = require_cjs();
    var BitString = class {
      unusedBits = 0;
      value = new ArrayBuffer(0);
      constructor(params, unusedBits = 0) {
        if (params) {
          if (typeof params === "number") {
            this.fromNumber(params);
          } else if ((0, utils_1.isBufferSource)(params)) {
            this.unusedBits = unusedBits;
            this.value = (0, utils_1.toArrayBuffer)(params);
          } else {
            throw TypeError("Unsupported type of 'params' argument for BitString");
          }
        }
      }
      fromASN(asn) {
        if (!(asn instanceof asn1js.BitString)) {
          throw new TypeError("Argument 'asn' is not instance of ASN.1 BitString");
        }
        this.unusedBits = asn.valueBlock.unusedBits;
        this.value = (0, utils_1.toArrayBuffer)(asn.valueBlock.valueHex);
        return this;
      }
      toASN() {
        return new asn1js.BitString({
          unusedBits: this.unusedBits,
          valueHex: this.value
        });
      }
      toSchema(name) {
        return new asn1js.BitString({ name });
      }
      toNumber() {
        let res = "";
        const uintArray = new Uint8Array(this.value);
        for (const octet of uintArray) {
          res += octet.toString(2).padStart(8, "0");
        }
        res = res.split("").reverse().join("");
        if (this.unusedBits) {
          res = res.slice(this.unusedBits).padStart(this.unusedBits, "0");
        }
        return parseInt(res, 2);
      }
      fromNumber(value) {
        let bits = value.toString(2);
        const octetSize = bits.length + 7 >> 3;
        this.unusedBits = (octetSize << 3) - bits.length;
        const octets = new Uint8Array(octetSize);
        bits = bits.padStart(octetSize << 3, "0").split("").reverse().join("");
        let index = 0;
        while (index < octetSize) {
          octets[index] = parseInt(bits.slice(index << 3, (index << 3) + 8), 2);
          index++;
        }
        this.value = octets.buffer;
      }
    };
    exports.BitString = BitString;
  }
});

// node_modules/@peculiar/asn1-schema/build/cjs/types/octet_string.js
var require_octet_string = __commonJS({
  "node_modules/@peculiar/asn1-schema/build/cjs/types/octet_string.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.OctetString = void 0;
    var tslib_1 = (init_tslib_es6(), __toCommonJS(tslib_es6_exports));
    var asn1js = tslib_1.__importStar(require_build2());
    var utils_1 = require_cjs();
    var OctetString = class {
      buffer;
      get byteLength() {
        return this.buffer.byteLength;
      }
      get byteOffset() {
        return 0;
      }
      constructor(param) {
        if (typeof param === "number") {
          this.buffer = new ArrayBuffer(param);
        } else {
          if ((0, utils_1.isBufferSource)(param)) {
            this.buffer = (0, utils_1.toArrayBuffer)(param);
          } else if (Array.isArray(param)) {
            this.buffer = new Uint8Array(param).buffer;
          } else {
            this.buffer = new ArrayBuffer(0);
          }
        }
      }
      fromASN(asn) {
        if (!(asn instanceof asn1js.OctetString)) {
          throw new TypeError("Argument 'asn' is not instance of ASN.1 OctetString");
        }
        this.buffer = (0, utils_1.toArrayBuffer)(asn.valueBlock.valueHex);
        return this;
      }
      toASN() {
        return new asn1js.OctetString({ valueHex: this.buffer });
      }
      toSchema(name) {
        return new asn1js.OctetString({ name });
      }
    };
    exports.OctetString = OctetString;
  }
});

// node_modules/@peculiar/asn1-schema/build/cjs/types/index.js
var require_types = __commonJS({
  "node_modules/@peculiar/asn1-schema/build/cjs/types/index.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    var tslib_1 = (init_tslib_es6(), __toCommonJS(tslib_es6_exports));
    tslib_1.__exportStar(require_bit_string(), exports);
    tslib_1.__exportStar(require_octet_string(), exports);
  }
});

// node_modules/@peculiar/asn1-schema/build/cjs/converters.js
var require_converters2 = __commonJS({
  "node_modules/@peculiar/asn1-schema/build/cjs/converters.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.AsnNullConverter = exports.AsnGeneralizedTimeConverter = exports.AsnUTCTimeConverter = exports.AsnCharacterStringConverter = exports.AsnGeneralStringConverter = exports.AsnVisibleStringConverter = exports.AsnGraphicStringConverter = exports.AsnIA5StringConverter = exports.AsnVideotexStringConverter = exports.AsnTeletexStringConverter = exports.AsnPrintableStringConverter = exports.AsnNumericStringConverter = exports.AsnUniversalStringConverter = exports.AsnBmpStringConverter = exports.AsnUtf8StringConverter = exports.AsnConstructedOctetStringConverter = exports.AsnOctetStringConverter = exports.AsnBooleanConverter = exports.AsnRelativeObjectIdentifierConverter = exports.AsnObjectIdentifierConverter = exports.AsnBitStringConverter = exports.AsnIntegerBigIntConverter = exports.AsnIntegerArrayBufferConverter = exports.AsnEnumeratedConverter = exports.AsnIntegerConverter = exports.AsnAnyConverter = void 0;
    exports.defaultConverter = defaultConverter;
    var tslib_1 = (init_tslib_es6(), __toCommonJS(tslib_es6_exports));
    var asn1js = tslib_1.__importStar(require_build2());
    var utils_1 = require_cjs();
    var enums_1 = require_enums();
    var index_1 = require_types();
    exports.AsnAnyConverter = {
      fromASN: (value) => value instanceof asn1js.Null ? null : (0, utils_1.toArrayBuffer)(value.valueBeforeDecodeView),
      toASN: (value) => {
        if (value === null) {
          return new asn1js.Null();
        }
        const schema = asn1js.fromBER(value);
        if (schema.result.error) {
          throw new Error(schema.result.error);
        }
        return schema.result;
      }
    };
    exports.AsnIntegerConverter = {
      fromASN: (value) => value.valueBlock.valueHexView.byteLength >= 4 ? value.valueBlock.toString() : value.valueBlock.valueDec,
      toASN: (value) => new asn1js.Integer({ value: +value })
    };
    exports.AsnEnumeratedConverter = {
      fromASN: (value) => value.valueBlock.valueDec,
      toASN: (value) => new asn1js.Enumerated({ value })
    };
    exports.AsnIntegerArrayBufferConverter = {
      fromASN: (value) => (0, utils_1.toArrayBuffer)(value.valueBlock.valueHexView),
      toASN: (value) => new asn1js.Integer({ valueHex: value })
    };
    exports.AsnIntegerBigIntConverter = {
      fromASN: (value) => value.toBigInt(),
      toASN: (value) => asn1js.Integer.fromBigInt(value)
    };
    exports.AsnBitStringConverter = {
      fromASN: (value) => (0, utils_1.toArrayBuffer)(value.valueBlock.valueHexView),
      toASN: (value) => new asn1js.BitString({ valueHex: value })
    };
    exports.AsnObjectIdentifierConverter = {
      fromASN: (value) => value.valueBlock.toString(),
      toASN: (value) => new asn1js.ObjectIdentifier({ value })
    };
    exports.AsnRelativeObjectIdentifierConverter = {
      fromASN: (value) => value.valueBlock.toString(),
      toASN: (value) => new asn1js.RelativeObjectIdentifier({ value })
    };
    exports.AsnBooleanConverter = {
      fromASN: (value) => value.valueBlock.value,
      toASN: (value) => new asn1js.Boolean({ value })
    };
    exports.AsnOctetStringConverter = {
      fromASN: (value) => (0, utils_1.toArrayBuffer)(value.valueBlock.valueHexView),
      toASN: (value) => new asn1js.OctetString({ valueHex: value })
    };
    exports.AsnConstructedOctetStringConverter = {
      fromASN: (value) => new index_1.OctetString(value.getValue()),
      toASN: (value) => value.toASN()
    };
    function createStringConverter(Asn1Type) {
      return {
        fromASN: (value) => value.valueBlock.value,
        toASN: (value) => new Asn1Type({ value })
      };
    }
    exports.AsnUtf8StringConverter = createStringConverter(asn1js.Utf8String);
    exports.AsnBmpStringConverter = createStringConverter(asn1js.BmpString);
    exports.AsnUniversalStringConverter = createStringConverter(asn1js.UniversalString);
    exports.AsnNumericStringConverter = createStringConverter(asn1js.NumericString);
    exports.AsnPrintableStringConverter = createStringConverter(asn1js.PrintableString);
    exports.AsnTeletexStringConverter = createStringConverter(asn1js.TeletexString);
    exports.AsnVideotexStringConverter = createStringConverter(asn1js.VideotexString);
    exports.AsnIA5StringConverter = createStringConverter(asn1js.IA5String);
    exports.AsnGraphicStringConverter = createStringConverter(asn1js.GraphicString);
    exports.AsnVisibleStringConverter = createStringConverter(asn1js.VisibleString);
    exports.AsnGeneralStringConverter = createStringConverter(asn1js.GeneralString);
    exports.AsnCharacterStringConverter = createStringConverter(asn1js.CharacterString);
    exports.AsnUTCTimeConverter = {
      fromASN: (value) => value.toDate(),
      toASN: (value) => new asn1js.UTCTime({ valueDate: value })
    };
    exports.AsnGeneralizedTimeConverter = {
      fromASN: (value) => value.toDate(),
      toASN: (value) => new asn1js.GeneralizedTime({ valueDate: value })
    };
    exports.AsnNullConverter = {
      fromASN: () => null,
      toASN: () => {
        return new asn1js.Null();
      }
    };
    function defaultConverter(type) {
      switch (type) {
        case enums_1.AsnPropTypes.Any:
          return exports.AsnAnyConverter;
        case enums_1.AsnPropTypes.BitString:
          return exports.AsnBitStringConverter;
        case enums_1.AsnPropTypes.BmpString:
          return exports.AsnBmpStringConverter;
        case enums_1.AsnPropTypes.Boolean:
          return exports.AsnBooleanConverter;
        case enums_1.AsnPropTypes.CharacterString:
          return exports.AsnCharacterStringConverter;
        case enums_1.AsnPropTypes.Enumerated:
          return exports.AsnEnumeratedConverter;
        case enums_1.AsnPropTypes.GeneralString:
          return exports.AsnGeneralStringConverter;
        case enums_1.AsnPropTypes.GeneralizedTime:
          return exports.AsnGeneralizedTimeConverter;
        case enums_1.AsnPropTypes.GraphicString:
          return exports.AsnGraphicStringConverter;
        case enums_1.AsnPropTypes.IA5String:
          return exports.AsnIA5StringConverter;
        case enums_1.AsnPropTypes.Integer:
          return exports.AsnIntegerConverter;
        case enums_1.AsnPropTypes.Null:
          return exports.AsnNullConverter;
        case enums_1.AsnPropTypes.NumericString:
          return exports.AsnNumericStringConverter;
        case enums_1.AsnPropTypes.ObjectIdentifier:
          return exports.AsnObjectIdentifierConverter;
        case enums_1.AsnPropTypes.RelativeObjectIdentifier:
          return exports.AsnRelativeObjectIdentifierConverter;
        case enums_1.AsnPropTypes.OctetString:
          return exports.AsnOctetStringConverter;
        case enums_1.AsnPropTypes.PrintableString:
          return exports.AsnPrintableStringConverter;
        case enums_1.AsnPropTypes.TeletexString:
          return exports.AsnTeletexStringConverter;
        case enums_1.AsnPropTypes.UTCTime:
          return exports.AsnUTCTimeConverter;
        case enums_1.AsnPropTypes.UniversalString:
          return exports.AsnUniversalStringConverter;
        case enums_1.AsnPropTypes.Utf8String:
          return exports.AsnUtf8StringConverter;
        case enums_1.AsnPropTypes.VideotexString:
          return exports.AsnVideotexStringConverter;
        case enums_1.AsnPropTypes.VisibleString:
          return exports.AsnVisibleStringConverter;
        default:
          return null;
      }
    }
  }
});

// node_modules/@peculiar/asn1-schema/build/cjs/helper.js
var require_helper = __commonJS({
  "node_modules/@peculiar/asn1-schema/build/cjs/helper.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.isConvertible = isConvertible;
    exports.isTypeOfArray = isTypeOfArray;
    exports.isArrayEqual = isArrayEqual;
    function isConvertible(target) {
      if (typeof target === "function" && target.prototype) {
        if (target.prototype.toASN && target.prototype.fromASN) {
          return true;
        } else {
          return isConvertible(target.prototype);
        }
      } else {
        return !!(target && typeof target === "object" && "toASN" in target && "fromASN" in target);
      }
    }
    function isTypeOfArray(target) {
      if (target) {
        const proto = Object.getPrototypeOf(target);
        if (proto?.prototype?.constructor === Array) {
          return true;
        }
        return isTypeOfArray(proto);
      }
      return false;
    }
    function isArrayEqual(bytes1, bytes2) {
      if (!(bytes1 && bytes2)) {
        return false;
      }
      if (bytes1.byteLength !== bytes2.byteLength) {
        return false;
      }
      const b1 = new Uint8Array(bytes1);
      const b2 = new Uint8Array(bytes2);
      for (let i = 0; i < bytes1.byteLength; i++) {
        if (b1[i] !== b2[i]) {
          return false;
        }
      }
      return true;
    }
  }
});

// node_modules/@peculiar/asn1-schema/build/cjs/schema.js
var require_schema = __commonJS({
  "node_modules/@peculiar/asn1-schema/build/cjs/schema.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.AsnSchemaStorage = void 0;
    var tslib_1 = (init_tslib_es6(), __toCommonJS(tslib_es6_exports));
    var asn1js = tslib_1.__importStar(require_build2());
    var enums_1 = require_enums();
    var helper_1 = require_helper();
    var AsnSchemaStorage = class {
      items = /* @__PURE__ */ new WeakMap();
      has(target) {
        return this.items.has(target);
      }
      get(target, checkSchema = false) {
        const schema = this.items.get(target);
        if (!schema) {
          throw new Error(`Cannot get schema for '${target.prototype.constructor.name}' target`);
        }
        if (checkSchema && !schema.schema) {
          throw new Error(`Schema '${target.prototype.constructor.name}' doesn't contain ASN.1 schema. Call 'AsnSchemaStorage.cache'.`);
        }
        return schema;
      }
      cache(target) {
        const schema = this.get(target);
        if (!schema.schema) {
          schema.schema = this.create(target, true);
        }
      }
      createDefault(target) {
        const schema = {
          type: enums_1.AsnTypeTypes.Sequence,
          items: {}
        };
        const parentSchema = this.findParentSchema(target);
        if (parentSchema) {
          Object.assign(schema, parentSchema);
          schema.items = Object.assign({}, schema.items, parentSchema.items);
        }
        return schema;
      }
      create(target, useNames) {
        const schema = this.items.get(target) || this.createDefault(target);
        const asn1Value = [];
        for (const key in schema.items) {
          const item = schema.items[key];
          const name = useNames ? key : "";
          let asn1Item;
          if (typeof item.type === "number") {
            const Asn1TypeName = enums_1.AsnPropTypes[item.type];
            const Asn1Type = asn1js[Asn1TypeName];
            if (!Asn1Type) {
              throw new Error(`Cannot get ASN1 class by name '${Asn1TypeName}'`);
            }
            asn1Item = new Asn1Type({ name });
          } else if ((0, helper_1.isConvertible)(item.type)) {
            const instance = new item.type();
            asn1Item = instance.toSchema(name);
          } else if (item.optional) {
            const itemSchema = this.get(item.type);
            if (itemSchema.type === enums_1.AsnTypeTypes.Choice) {
              asn1Item = new asn1js.Any({ name });
            } else {
              asn1Item = this.create(item.type, false);
              asn1Item.name = name;
            }
          } else {
            asn1Item = new asn1js.Any({ name });
          }
          const optional = !!item.optional || item.defaultValue !== void 0;
          if (item.repeated) {
            asn1Item.name = "";
            const Container = item.repeated === "set" ? asn1js.Set : asn1js.Sequence;
            asn1Item = new Container({
              name: "",
              value: [
                new asn1js.Repeated({
                  name,
                  value: asn1Item
                })
              ]
            });
          }
          if (item.context !== null && item.context !== void 0) {
            if (item.implicit) {
              if (typeof item.type === "number" || (0, helper_1.isConvertible)(item.type)) {
                const Container = item.repeated ? asn1js.Constructed : asn1js.Primitive;
                asn1Value.push(new Container({
                  name,
                  optional,
                  idBlock: {
                    tagClass: 3,
                    tagNumber: item.context
                  }
                }));
              } else {
                this.cache(item.type);
                const isRepeated = !!item.repeated;
                let value = !isRepeated ? this.get(item.type, true).schema : asn1Item;
                value = "valueBlock" in value ? value.valueBlock.value : value.value;
                asn1Value.push(new asn1js.Constructed({
                  name: !isRepeated ? name : "",
                  optional,
                  idBlock: {
                    tagClass: 3,
                    tagNumber: item.context
                  },
                  value
                }));
              }
            } else {
              asn1Value.push(new asn1js.Constructed({
                optional,
                idBlock: {
                  tagClass: 3,
                  tagNumber: item.context
                },
                value: [asn1Item]
              }));
            }
          } else {
            asn1Item.optional = optional;
            asn1Value.push(asn1Item);
          }
        }
        switch (schema.type) {
          case enums_1.AsnTypeTypes.Sequence:
            return new asn1js.Sequence({
              value: asn1Value,
              name: ""
            });
          case enums_1.AsnTypeTypes.Set:
            return new asn1js.Set({
              value: asn1Value,
              name: ""
            });
          case enums_1.AsnTypeTypes.Choice:
            return new asn1js.Choice({
              value: asn1Value,
              name: ""
            });
          default:
            throw new Error("Unsupported ASN1 type in use");
        }
      }
      set(target, schema) {
        this.items.set(target, schema);
        return this;
      }
      findParentSchema(target) {
        const parent = Object.getPrototypeOf(target);
        if (parent) {
          const schema = this.items.get(parent);
          return schema || this.findParentSchema(parent);
        }
        return null;
      }
    };
    exports.AsnSchemaStorage = AsnSchemaStorage;
  }
});

// node_modules/@peculiar/asn1-schema/build/cjs/storage.js
var require_storage = __commonJS({
  "node_modules/@peculiar/asn1-schema/build/cjs/storage.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.schemaStorage = void 0;
    var schema_1 = require_schema();
    exports.schemaStorage = new schema_1.AsnSchemaStorage();
  }
});

// node_modules/@peculiar/asn1-schema/build/cjs/decorators.js
var require_decorators = __commonJS({
  "node_modules/@peculiar/asn1-schema/build/cjs/decorators.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.AsnProp = exports.AsnSequenceType = exports.AsnSetType = exports.AsnChoiceType = exports.AsnType = void 0;
    var tslib_1 = (init_tslib_es6(), __toCommonJS(tslib_es6_exports));
    var converters = tslib_1.__importStar(require_converters2());
    var enums_1 = require_enums();
    var storage_1 = require_storage();
    var AsnType = (options) => (target) => {
      let schema;
      if (!storage_1.schemaStorage.has(target)) {
        schema = storage_1.schemaStorage.createDefault(target);
        storage_1.schemaStorage.set(target, schema);
      } else {
        schema = storage_1.schemaStorage.get(target);
      }
      Object.assign(schema, options);
    };
    exports.AsnType = AsnType;
    var AsnChoiceType = () => (0, exports.AsnType)({ type: enums_1.AsnTypeTypes.Choice });
    exports.AsnChoiceType = AsnChoiceType;
    var AsnSetType = (options) => (0, exports.AsnType)({
      type: enums_1.AsnTypeTypes.Set,
      ...options
    });
    exports.AsnSetType = AsnSetType;
    var AsnSequenceType = (options) => (0, exports.AsnType)({
      type: enums_1.AsnTypeTypes.Sequence,
      ...options
    });
    exports.AsnSequenceType = AsnSequenceType;
    var AsnProp = (options) => (target, propertyKey) => {
      let schema;
      if (!storage_1.schemaStorage.has(target.constructor)) {
        schema = storage_1.schemaStorage.createDefault(target.constructor);
        storage_1.schemaStorage.set(target.constructor, schema);
      } else {
        schema = storage_1.schemaStorage.get(target.constructor);
      }
      const copyOptions = Object.assign({}, options);
      if (typeof copyOptions.type === "number" && !copyOptions.converter) {
        const defaultConverter = converters.defaultConverter(options.type);
        if (!defaultConverter) {
          throw new Error(`Cannot get default converter for property '${propertyKey}' of ${target.constructor.name}`);
        }
        copyOptions.converter = defaultConverter;
      }
      copyOptions.raw = options.raw;
      schema.items[propertyKey] = copyOptions;
    };
    exports.AsnProp = AsnProp;
  }
});

// node_modules/@peculiar/asn1-schema/build/cjs/errors/schema_validation.js
var require_schema_validation = __commonJS({
  "node_modules/@peculiar/asn1-schema/build/cjs/errors/schema_validation.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.AsnSchemaValidationError = void 0;
    var AsnSchemaValidationError = class extends Error {
      schemas = [];
    };
    exports.AsnSchemaValidationError = AsnSchemaValidationError;
  }
});

// node_modules/@peculiar/asn1-schema/build/cjs/errors/index.js
var require_errors = __commonJS({
  "node_modules/@peculiar/asn1-schema/build/cjs/errors/index.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    var tslib_1 = (init_tslib_es6(), __toCommonJS(tslib_es6_exports));
    tslib_1.__exportStar(require_schema_validation(), exports);
  }
});

// node_modules/@peculiar/asn1-schema/build/cjs/parser.js
var require_parser = __commonJS({
  "node_modules/@peculiar/asn1-schema/build/cjs/parser.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.AsnParser = void 0;
    var tslib_1 = (init_tslib_es6(), __toCommonJS(tslib_es6_exports));
    var asn1js = tslib_1.__importStar(require_build2());
    var utils_1 = require_cjs();
    var enums_1 = require_enums();
    var converters = tslib_1.__importStar(require_converters2());
    var errors_1 = require_errors();
    var helper_1 = require_helper();
    var storage_1 = require_storage();
    var AsnParser = class {
      static parse(data, target, options) {
        const asn1Parsed = asn1js.fromBER((0, utils_1.toArrayBuffer)(data), options?.berOptions);
        if (asn1Parsed.result.error) {
          throw new Error(asn1Parsed.result.error);
        }
        const res = this.fromASN(asn1Parsed.result, target, options);
        return res;
      }
      static fromASN(asn1Schema, target, options) {
        try {
          if ((0, helper_1.isConvertible)(target)) {
            const value = new target();
            return value.fromASN(asn1Schema);
          }
          const schema = storage_1.schemaStorage.get(target);
          storage_1.schemaStorage.cache(target);
          let targetSchema = schema.schema;
          const choiceResult = this.handleChoiceTypes(asn1Schema, schema, target, targetSchema, options);
          if (choiceResult?.result) {
            return choiceResult.result;
          }
          if (choiceResult?.targetSchema) {
            targetSchema = choiceResult.targetSchema;
          }
          const sequenceResult = this.handleSequenceTypes(asn1Schema, schema, target, targetSchema);
          const res = new target();
          if ((0, helper_1.isTypeOfArray)(target)) {
            return this.handleArrayTypes(asn1Schema, schema, target, options);
          }
          this.processSchemaItems(schema, sequenceResult, res, options);
          return res;
        } catch (error) {
          if (error instanceof errors_1.AsnSchemaValidationError) {
            error.schemas.push(target.name);
          }
          throw error;
        }
      }
      static handleChoiceTypes(asn1Schema, schema, target, targetSchema, options) {
        if (asn1Schema.constructor === asn1js.Constructed && schema.type === enums_1.AsnTypeTypes.Choice && asn1Schema.idBlock.tagClass === 3) {
          for (const key in schema.items) {
            const schemaItem = schema.items[key];
            if (schemaItem.context === asn1Schema.idBlock.tagNumber && schemaItem.implicit) {
              if (typeof schemaItem.type === "function" && storage_1.schemaStorage.has(schemaItem.type)) {
                const fieldSchema = storage_1.schemaStorage.get(schemaItem.type);
                if (fieldSchema && fieldSchema.type === enums_1.AsnTypeTypes.Sequence) {
                  const newSeq = new asn1js.Sequence();
                  if ("value" in asn1Schema.valueBlock && Array.isArray(asn1Schema.valueBlock.value) && "value" in newSeq.valueBlock) {
                    newSeq.valueBlock.value = asn1Schema.valueBlock.value;
                    const fieldValue = this.fromASN(newSeq, schemaItem.type, options);
                    const res = new target();
                    res[key] = fieldValue;
                    return { result: res };
                  }
                }
              }
            }
          }
        } else if (asn1Schema.constructor === asn1js.Constructed && schema.type !== enums_1.AsnTypeTypes.Choice) {
          const newTargetSchema = new asn1js.Constructed({
            idBlock: {
              tagClass: 3,
              tagNumber: asn1Schema.idBlock.tagNumber
            },
            value: schema.schema.valueBlock.value
          });
          for (const key in schema.items) {
            delete asn1Schema[key];
          }
          return { targetSchema: newTargetSchema };
        }
        return null;
      }
      static handleSequenceTypes(asn1Schema, schema, target, targetSchema) {
        if (schema.type === enums_1.AsnTypeTypes.Sequence) {
          const asn1ComparedSchema = asn1js.compareSchema({}, asn1Schema, targetSchema);
          if (!asn1ComparedSchema.verified) {
            throw new errors_1.AsnSchemaValidationError(`Data does not match to ${target.name} ASN1 schema.${asn1ComparedSchema.result.error ? ` ${asn1ComparedSchema.result.error}` : ""}`);
          }
          return asn1ComparedSchema;
        } else {
          const asn1ComparedSchema = asn1js.compareSchema({}, asn1Schema, targetSchema);
          if (!asn1ComparedSchema.verified) {
            throw new errors_1.AsnSchemaValidationError(`Data does not match to ${target.name} ASN1 schema.${asn1ComparedSchema.result.error ? ` ${asn1ComparedSchema.result.error}` : ""}`);
          }
          return asn1ComparedSchema;
        }
      }
      static processRepeatedField(asn1Elements, asn1Index, schemaItem) {
        let elementsToProcess = asn1Elements.slice(asn1Index);
        if (elementsToProcess.length === 1 && elementsToProcess[0].constructor.name === "Sequence") {
          const seq = elementsToProcess[0];
          if (seq.valueBlock && seq.valueBlock.value && Array.isArray(seq.valueBlock.value)) {
            elementsToProcess = seq.valueBlock.value;
          }
        }
        if (typeof schemaItem.type === "number") {
          const converter = converters.defaultConverter(schemaItem.type);
          if (!converter)
            throw new Error(`No converter for ASN.1 type ${schemaItem.type}`);
          return elementsToProcess.filter((el) => el && el.valueBlock).map((el) => {
            try {
              return converter.fromASN(el);
            } catch {
              return void 0;
            }
          }).filter((v) => v !== void 0);
        } else {
          return elementsToProcess.filter((el) => el && el.valueBlock).map((el) => {
            try {
              return this.fromASN(el, schemaItem.type);
            } catch {
              return void 0;
            }
          }).filter((v) => v !== void 0);
        }
      }
      static processPrimitiveField(asn1Element, schemaItem) {
        const converter = converters.defaultConverter(schemaItem.type);
        if (!converter)
          throw new Error(`No converter for ASN.1 type ${schemaItem.type}`);
        return converter.fromASN(asn1Element);
      }
      static isOptionalChoiceField(schemaItem) {
        return schemaItem.optional && typeof schemaItem.type === "function" && storage_1.schemaStorage.has(schemaItem.type) && storage_1.schemaStorage.get(schemaItem.type).type === enums_1.AsnTypeTypes.Choice;
      }
      static processOptionalChoiceField(asn1Element, schemaItem) {
        try {
          const value = this.fromASN(asn1Element, schemaItem.type);
          return {
            processed: true,
            value
          };
        } catch (err) {
          if (err instanceof errors_1.AsnSchemaValidationError && /Wrong values for Choice type/.test(err.message)) {
            return { processed: false };
          }
          throw err;
        }
      }
      static handleArrayTypes(asn1Schema, schema, target, options) {
        if (!("value" in asn1Schema.valueBlock && Array.isArray(asn1Schema.valueBlock.value))) {
          throw new Error("Cannot get items from the ASN.1 parsed value. ASN.1 object is not constructed.");
        }
        const itemType = schema.itemType;
        if (typeof itemType === "number") {
          const converter = converters.defaultConverter(itemType);
          if (!converter) {
            throw new Error(`Cannot get default converter for array item of ${target.name} ASN1 schema`);
          }
          return target.from(asn1Schema.valueBlock.value, (element) => converter.fromASN(element));
        } else {
          return target.from(asn1Schema.valueBlock.value, (element) => this.fromASN(element, itemType, options));
        }
      }
      static processSchemaItems(schema, asn1ComparedSchema, res, options) {
        for (const key in schema.items) {
          const asn1SchemaValue = asn1ComparedSchema.result[key];
          if (!asn1SchemaValue) {
            continue;
          }
          const schemaItem = schema.items[key];
          const schemaItemType = schemaItem.type;
          let parsedValue;
          if (typeof schemaItemType === "number" || (0, helper_1.isConvertible)(schemaItemType)) {
            parsedValue = this.processPrimitiveSchemaItem(asn1SchemaValue, schemaItem, schemaItemType, options);
          } else {
            parsedValue = this.processComplexSchemaItem(asn1SchemaValue, schemaItem, schemaItemType, options);
          }
          if (parsedValue && typeof parsedValue === "object" && "value" in parsedValue && "raw" in parsedValue) {
            res[key] = parsedValue.value;
            res[`${key}Raw`] = parsedValue.raw;
          } else {
            res[key] = parsedValue;
          }
        }
      }
      static processPrimitiveSchemaItem(asn1SchemaValue, schemaItem, schemaItemType, options) {
        const converter = schemaItem.converter ?? ((0, helper_1.isConvertible)(schemaItemType) ? new schemaItemType() : null);
        if (!converter) {
          throw new Error("Converter is empty");
        }
        if (schemaItem.repeated) {
          return this.processRepeatedPrimitiveItem(asn1SchemaValue, schemaItem, converter, options);
        } else {
          return this.processSinglePrimitiveItem(asn1SchemaValue, schemaItem, schemaItemType, converter, options);
        }
      }
      static processRepeatedPrimitiveItem(asn1SchemaValue, schemaItem, converter, options) {
        if (schemaItem.implicit) {
          const Container = schemaItem.repeated === "sequence" ? asn1js.Sequence : asn1js.Set;
          const newItem = new Container();
          newItem.valueBlock = asn1SchemaValue.valueBlock;
          const newItemAsn = asn1js.fromBER(newItem.toBER(false), options?.berOptions);
          if (newItemAsn.offset === -1) {
            throw new Error(`Cannot parse the child item. ${newItemAsn.result.error}`);
          }
          if (!("value" in newItemAsn.result.valueBlock && Array.isArray(newItemAsn.result.valueBlock.value))) {
            throw new Error("Cannot get items from the ASN.1 parsed value. ASN.1 object is not constructed.");
          }
          const value = newItemAsn.result.valueBlock.value;
          return Array.from(value, (element) => converter.fromASN(element));
        } else {
          return Array.from(asn1SchemaValue, (element) => converter.fromASN(element));
        }
      }
      static processSinglePrimitiveItem(asn1SchemaValue, schemaItem, schemaItemType, converter, options) {
        let value = asn1SchemaValue;
        if (schemaItem.implicit) {
          let newItem;
          if ((0, helper_1.isConvertible)(schemaItemType)) {
            newItem = new schemaItemType().toSchema("");
          } else {
            const Asn1TypeName = enums_1.AsnPropTypes[schemaItemType];
            const Asn1Type = asn1js[Asn1TypeName];
            if (!Asn1Type) {
              throw new Error(`Cannot get '${Asn1TypeName}' class from asn1js module`);
            }
            newItem = new Asn1Type();
          }
          newItem.valueBlock = value.valueBlock;
          value = asn1js.fromBER(newItem.toBER(false), options?.berOptions).result;
        }
        return converter.fromASN(value);
      }
      static processComplexSchemaItem(asn1SchemaValue, schemaItem, schemaItemType, options) {
        if (schemaItem.repeated) {
          if (!Array.isArray(asn1SchemaValue)) {
            throw new Error("Cannot get list of items from the ASN.1 parsed value. ASN.1 value should be iterable.");
          }
          return Array.from(asn1SchemaValue, (element) => this.fromASN(element, schemaItemType, options));
        } else {
          const valueToProcess = this.handleImplicitTagging(asn1SchemaValue, schemaItem, schemaItemType);
          if (this.isOptionalChoiceField(schemaItem)) {
            try {
              return this.fromASN(valueToProcess, schemaItemType, options);
            } catch (err) {
              if (err instanceof errors_1.AsnSchemaValidationError && /Wrong values for Choice type/.test(err.message)) {
                return void 0;
              }
              throw err;
            }
          } else {
            const parsedValue = this.fromASN(valueToProcess, schemaItemType, options);
            if (schemaItem.raw) {
              return {
                value: parsedValue,
                raw: asn1SchemaValue.valueBeforeDecodeView
              };
            }
            return parsedValue;
          }
        }
      }
      static handleImplicitTagging(asn1SchemaValue, schemaItem, schemaItemType) {
        if (schemaItem.implicit && typeof schemaItem.context === "number") {
          const schema = storage_1.schemaStorage.get(schemaItemType);
          if (schema.type === enums_1.AsnTypeTypes.Sequence) {
            const newSeq = new asn1js.Sequence();
            if ("value" in asn1SchemaValue.valueBlock && Array.isArray(asn1SchemaValue.valueBlock.value) && "value" in newSeq.valueBlock) {
              newSeq.valueBlock.value = asn1SchemaValue.valueBlock.value;
              return newSeq;
            }
          } else if (schema.type === enums_1.AsnTypeTypes.Set) {
            const newSet = new asn1js.Set();
            if ("value" in asn1SchemaValue.valueBlock && Array.isArray(asn1SchemaValue.valueBlock.value) && "value" in newSet.valueBlock) {
              newSet.valueBlock.value = asn1SchemaValue.valueBlock.value;
              return newSet;
            }
          }
        }
        return asn1SchemaValue;
      }
    };
    exports.AsnParser = AsnParser;
  }
});

// node_modules/@peculiar/asn1-schema/build/cjs/serializer.js
var require_serializer = __commonJS({
  "node_modules/@peculiar/asn1-schema/build/cjs/serializer.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.AsnSerializer = void 0;
    var tslib_1 = (init_tslib_es6(), __toCommonJS(tslib_es6_exports));
    var asn1js = tslib_1.__importStar(require_build2());
    var utils_1 = require_cjs();
    var converters = tslib_1.__importStar(require_converters2());
    var enums_1 = require_enums();
    var helper_1 = require_helper();
    var storage_1 = require_storage();
    var AsnSerializer = class _AsnSerializer {
      static serialize(obj) {
        if (obj instanceof asn1js.BaseBlock) {
          return obj.toBER(false);
        }
        return this.toASN(obj).toBER(false);
      }
      static toASN(obj) {
        if (obj && typeof obj === "object" && (0, helper_1.isConvertible)(obj)) {
          return obj.toASN();
        }
        if (!(obj && typeof obj === "object")) {
          throw new TypeError("Parameter 1 should be type of Object.");
        }
        const target = obj.constructor;
        const schema = storage_1.schemaStorage.get(target);
        storage_1.schemaStorage.cache(target);
        let asn1Value = [];
        if (schema.itemType) {
          if (!Array.isArray(obj)) {
            throw new TypeError("Parameter 1 should be type of Array.");
          }
          if (typeof schema.itemType === "number") {
            const converter = converters.defaultConverter(schema.itemType);
            if (!converter) {
              throw new Error(`Cannot get default converter for array item of ${target.name} ASN1 schema`);
            }
            asn1Value = obj.map((o) => converter.toASN(o));
          } else {
            asn1Value = obj.map((o) => this.toAsnItem({ type: schema.itemType }, "[]", target, o));
          }
        } else {
          for (const key in schema.items) {
            const schemaItem = schema.items[key];
            const objProp = obj[key];
            if (objProp === void 0 || schemaItem.defaultValue === objProp || typeof schemaItem.defaultValue === "object" && typeof objProp === "object" && (0, helper_1.isArrayEqual)(this.serialize(schemaItem.defaultValue), this.serialize(objProp))) {
              continue;
            }
            const asn1Item = _AsnSerializer.toAsnItem(schemaItem, key, target, objProp);
            if (typeof schemaItem.context === "number") {
              if (schemaItem.implicit) {
                if (!schemaItem.repeated && (typeof schemaItem.type === "number" || (0, helper_1.isConvertible)(schemaItem.type))) {
                  const value = {};
                  value.valueHex = asn1Item instanceof asn1js.Null ? (0, utils_1.toArrayBuffer)(asn1Item.valueBeforeDecodeView) : asn1Item.valueBlock.toBER();
                  asn1Value.push(new asn1js.Primitive({
                    optional: schemaItem.optional,
                    idBlock: {
                      tagClass: 3,
                      tagNumber: schemaItem.context
                    },
                    ...value
                  }));
                } else {
                  asn1Value.push(new asn1js.Constructed({
                    optional: schemaItem.optional,
                    idBlock: {
                      tagClass: 3,
                      tagNumber: schemaItem.context
                    },
                    value: asn1Item.valueBlock.value
                  }));
                }
              } else {
                asn1Value.push(new asn1js.Constructed({
                  optional: schemaItem.optional,
                  idBlock: {
                    tagClass: 3,
                    tagNumber: schemaItem.context
                  },
                  value: [asn1Item]
                }));
              }
            } else if (schemaItem.repeated) {
              asn1Value = asn1Value.concat(asn1Item);
            } else {
              asn1Value.push(asn1Item);
            }
          }
        }
        let asnSchema;
        switch (schema.type) {
          case enums_1.AsnTypeTypes.Sequence:
            asnSchema = new asn1js.Sequence({ value: asn1Value });
            break;
          case enums_1.AsnTypeTypes.Set:
            asnSchema = new asn1js.Set({ value: asn1Value });
            break;
          case enums_1.AsnTypeTypes.Choice:
            if (!asn1Value[0]) {
              throw new Error(`Schema '${target.name}' has wrong data. Choice cannot be empty.`);
            }
            asnSchema = asn1Value[0];
            break;
        }
        return asnSchema;
      }
      static toAsnItem(schemaItem, key, target, objProp) {
        let asn1Item;
        if (typeof schemaItem.type === "number") {
          const converter = schemaItem.converter;
          if (!converter) {
            throw new Error(`Property '${key}' doesn't have converter for type ${enums_1.AsnPropTypes[schemaItem.type]} in schema '${target.name}'`);
          }
          if (schemaItem.repeated) {
            if (!Array.isArray(objProp)) {
              throw new TypeError("Parameter 'objProp' should be type of Array.");
            }
            const items = Array.from(objProp, (element) => converter.toASN(element));
            const Container = schemaItem.repeated === "sequence" ? asn1js.Sequence : asn1js.Set;
            asn1Item = new Container({ value: items });
          } else {
            asn1Item = converter.toASN(objProp);
          }
        } else {
          if (schemaItem.repeated) {
            if (!Array.isArray(objProp)) {
              throw new TypeError("Parameter 'objProp' should be type of Array.");
            }
            const items = Array.from(objProp, (element) => this.toASN(element));
            const Container = schemaItem.repeated === "sequence" ? asn1js.Sequence : asn1js.Set;
            asn1Item = new Container({ value: items });
          } else {
            asn1Item = this.toASN(objProp);
          }
        }
        return asn1Item;
      }
    };
    exports.AsnSerializer = AsnSerializer;
  }
});

// node_modules/@peculiar/asn1-schema/build/cjs/objects.js
var require_objects = __commonJS({
  "node_modules/@peculiar/asn1-schema/build/cjs/objects.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.AsnArray = void 0;
    var AsnArray = class extends Array {
      constructor(items = []) {
        if (typeof items === "number") {
          super(items);
        } else {
          super();
          for (const item of items) {
            this.push(item);
          }
        }
      }
    };
    exports.AsnArray = AsnArray;
  }
});

// node_modules/@peculiar/asn1-schema/build/cjs/convert.js
var require_convert3 = __commonJS({
  "node_modules/@peculiar/asn1-schema/build/cjs/convert.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.AsnConvert = void 0;
    var tslib_1 = (init_tslib_es6(), __toCommonJS(tslib_es6_exports));
    var asn1js = tslib_1.__importStar(require_build2());
    var utils_1 = require_cjs();
    var parser_1 = require_parser();
    var serializer_1 = require_serializer();
    var AsnConvert = class _AsnConvert {
      static serialize(obj) {
        return serializer_1.AsnSerializer.serialize(obj);
      }
      static parse(data, target, options) {
        return parser_1.AsnParser.parse(data, target, options);
      }
      static toString(data, options) {
        const buf = (0, utils_1.isBufferSource)(data) ? (0, utils_1.toArrayBuffer)(data) : _AsnConvert.serialize(data);
        const asn = asn1js.fromBER(buf, options?.berOptions);
        if (asn.offset === -1) {
          throw new Error(`Cannot decode ASN.1 data. ${asn.result.error}`);
        }
        return asn.result.toString();
      }
    };
    exports.AsnConvert = AsnConvert;
  }
});

// node_modules/@peculiar/asn1-schema/build/cjs/index.js
var require_cjs2 = __commonJS({
  "node_modules/@peculiar/asn1-schema/build/cjs/index.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.AsnSerializer = exports.AsnParser = exports.AsnPropTypes = exports.AsnTypeTypes = exports.AsnSetType = exports.AsnSequenceType = exports.AsnChoiceType = exports.AsnType = exports.AsnProp = void 0;
    var tslib_1 = (init_tslib_es6(), __toCommonJS(tslib_es6_exports));
    tslib_1.__exportStar(require_converters2(), exports);
    tslib_1.__exportStar(require_types(), exports);
    var decorators_1 = require_decorators();
    Object.defineProperty(exports, "AsnProp", { enumerable: true, get: function() {
      return decorators_1.AsnProp;
    } });
    Object.defineProperty(exports, "AsnType", { enumerable: true, get: function() {
      return decorators_1.AsnType;
    } });
    Object.defineProperty(exports, "AsnChoiceType", { enumerable: true, get: function() {
      return decorators_1.AsnChoiceType;
    } });
    Object.defineProperty(exports, "AsnSequenceType", { enumerable: true, get: function() {
      return decorators_1.AsnSequenceType;
    } });
    Object.defineProperty(exports, "AsnSetType", { enumerable: true, get: function() {
      return decorators_1.AsnSetType;
    } });
    var enums_1 = require_enums();
    Object.defineProperty(exports, "AsnTypeTypes", { enumerable: true, get: function() {
      return enums_1.AsnTypeTypes;
    } });
    Object.defineProperty(exports, "AsnPropTypes", { enumerable: true, get: function() {
      return enums_1.AsnPropTypes;
    } });
    var parser_1 = require_parser();
    Object.defineProperty(exports, "AsnParser", { enumerable: true, get: function() {
      return parser_1.AsnParser;
    } });
    var serializer_1 = require_serializer();
    Object.defineProperty(exports, "AsnSerializer", { enumerable: true, get: function() {
      return serializer_1.AsnSerializer;
    } });
    tslib_1.__exportStar(require_errors(), exports);
    tslib_1.__exportStar(require_objects(), exports);
    tslib_1.__exportStar(require_convert3(), exports);
  }
});

// node_modules/@peculiar/asn1-x509/build/cjs/ip_converter.js
var require_ip_converter = __commonJS({
  "node_modules/@peculiar/asn1-x509/build/cjs/ip_converter.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.IpConverter = void 0;
    var encoding_1 = require_encoding();
    var IpConverter = class {
      static isIPv4(ip) {
        return /^(\d{1,3}\.){3}\d{1,3}$/.test(ip);
      }
      static parseIPv4(ip) {
        const parts = ip.split(".");
        if (parts.length !== 4) {
          throw new Error("Invalid IPv4 address");
        }
        return parts.map((part) => {
          const num = parseInt(part, 10);
          if (isNaN(num) || num < 0 || num > 255) {
            throw new Error("Invalid IPv4 address part");
          }
          return num;
        });
      }
      static parseIPv6(ip) {
        const expandedIP = this.expandIPv6(ip);
        const parts = expandedIP.split(":");
        if (parts.length !== 8) {
          throw new Error("Invalid IPv6 address");
        }
        return parts.reduce((bytes, part) => {
          const num = parseInt(part, 16);
          if (isNaN(num) || num < 0 || num > 65535) {
            throw new Error("Invalid IPv6 address part");
          }
          bytes.push(num >> 8 & 255);
          bytes.push(num & 255);
          return bytes;
        }, []);
      }
      static expandIPv6(ip) {
        if (!ip.includes("::")) {
          return ip;
        }
        const parts = ip.split("::");
        if (parts.length > 2) {
          throw new Error("Invalid IPv6 address");
        }
        const left = parts[0] ? parts[0].split(":") : [];
        const right = parts[1] ? parts[1].split(":") : [];
        const missing = 8 - (left.length + right.length);
        if (missing < 0) {
          throw new Error("Invalid IPv6 address");
        }
        return [...left, ...Array(missing).fill("0"), ...right].join(":");
      }
      static formatIPv6(bytes) {
        const parts = [];
        for (let i = 0; i < 16; i += 2) {
          parts.push((bytes[i] << 8 | bytes[i + 1]).toString(16));
        }
        return this.compressIPv6(parts.join(":"));
      }
      static compressIPv6(ip) {
        const parts = ip.split(":");
        let longestZeroStart = -1;
        let longestZeroLength = 0;
        let currentZeroStart = -1;
        let currentZeroLength = 0;
        for (let i = 0; i < parts.length; i++) {
          if (parts[i] === "0") {
            if (currentZeroStart === -1) {
              currentZeroStart = i;
            }
            currentZeroLength++;
          } else {
            if (currentZeroLength > longestZeroLength) {
              longestZeroStart = currentZeroStart;
              longestZeroLength = currentZeroLength;
            }
            currentZeroStart = -1;
            currentZeroLength = 0;
          }
        }
        if (currentZeroLength > longestZeroLength) {
          longestZeroStart = currentZeroStart;
          longestZeroLength = currentZeroLength;
        }
        if (longestZeroLength > 1) {
          const before = parts.slice(0, longestZeroStart).join(":");
          const after = parts.slice(longestZeroStart + longestZeroLength).join(":");
          return `${before}::${after}`;
        }
        return ip;
      }
      static parseCIDR(text) {
        const [addr, prefixStr] = text.split("/");
        const prefix = parseInt(prefixStr, 10);
        if (this.isIPv4(addr)) {
          if (prefix < 0 || prefix > 32) {
            throw new Error("Invalid IPv4 prefix length");
          }
          return [this.parseIPv4(addr), prefix];
        } else {
          if (prefix < 0 || prefix > 128) {
            throw new Error("Invalid IPv6 prefix length");
          }
          return [this.parseIPv6(addr), prefix];
        }
      }
      static decodeIP(value) {
        if (value.length === 64 && parseInt(value, 16) === 0) {
          return "::/0";
        }
        if (value.length !== 16) {
          return value;
        }
        const mask = parseInt(value.slice(8), 16).toString(2).split("").reduce((a, k) => a + +k, 0);
        let ip = value.slice(0, 8).replace(/(.{2})/g, (match) => `${parseInt(match, 16)}.`);
        ip = ip.slice(0, -1);
        return `${ip}/${mask}`;
      }
      static toString(buf) {
        const uint8 = new Uint8Array(buf);
        if (uint8.length === 4) {
          return Array.from(uint8).join(".");
        }
        if (uint8.length === 16) {
          return this.formatIPv6(uint8);
        }
        if (uint8.length === 8 || uint8.length === 32) {
          const half = uint8.length / 2;
          const addrBytes = uint8.slice(0, half);
          const maskBytes = uint8.slice(half);
          const isAllZeros = uint8.every((byte) => byte === 0);
          if (isAllZeros) {
            return uint8.length === 8 ? "0.0.0.0/0" : "::/0";
          }
          const prefixLen = maskBytes.reduce((a, b) => a + (b.toString(2).match(/1/g) || []).length, 0);
          if (uint8.length === 8) {
            const addrStr = Array.from(addrBytes).join(".");
            return `${addrStr}/${prefixLen}`;
          } else {
            const addrStr = this.formatIPv6(addrBytes);
            return `${addrStr}/${prefixLen}`;
          }
        }
        return this.decodeIP(encoding_1.hex.encode(buf));
      }
      static fromString(text) {
        if (text.includes("/")) {
          const [addr, prefix] = this.parseCIDR(text);
          const maskBytes = new Uint8Array(addr.length);
          let bitsLeft = prefix;
          for (let i = 0; i < maskBytes.length; i++) {
            if (bitsLeft >= 8) {
              maskBytes[i] = 255;
              bitsLeft -= 8;
            } else if (bitsLeft > 0) {
              maskBytes[i] = 255 << 8 - bitsLeft;
              bitsLeft = 0;
            }
          }
          const out = new Uint8Array(addr.length * 2);
          out.set(addr, 0);
          out.set(maskBytes, addr.length);
          return out.buffer;
        }
        const bytes = this.isIPv4(text) ? this.parseIPv4(text) : this.parseIPv6(text);
        return new Uint8Array(bytes).buffer;
      }
    };
    exports.IpConverter = IpConverter;
  }
});

// node_modules/@peculiar/asn1-x509/build/cjs/name.js
var require_name = __commonJS({
  "node_modules/@peculiar/asn1-x509/build/cjs/name.js"(exports) {
    "use strict";
    var RelativeDistinguishedName_1;
    var RDNSequence_1;
    var Name_1;
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.Name = exports.RDNSequence = exports.RelativeDistinguishedName = exports.AttributeTypeAndValue = exports.AttributeValue = exports.DirectoryString = void 0;
    var tslib_1 = (init_tslib_es6(), __toCommonJS(tslib_es6_exports));
    var asn1_schema_1 = require_cjs2();
    var encoding_1 = require_encoding();
    var DirectoryString = class DirectoryString {
      teletexString;
      printableString;
      universalString;
      utf8String;
      bmpString;
      constructor(params = {}) {
        Object.assign(this, params);
      }
      toString() {
        return this.bmpString || this.printableString || this.teletexString || this.universalString || this.utf8String || "";
      }
    };
    exports.DirectoryString = DirectoryString;
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({ type: asn1_schema_1.AsnPropTypes.TeletexString })
    ], DirectoryString.prototype, "teletexString", void 0);
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({ type: asn1_schema_1.AsnPropTypes.PrintableString })
    ], DirectoryString.prototype, "printableString", void 0);
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({ type: asn1_schema_1.AsnPropTypes.UniversalString })
    ], DirectoryString.prototype, "universalString", void 0);
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({ type: asn1_schema_1.AsnPropTypes.Utf8String })
    ], DirectoryString.prototype, "utf8String", void 0);
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({ type: asn1_schema_1.AsnPropTypes.BmpString })
    ], DirectoryString.prototype, "bmpString", void 0);
    exports.DirectoryString = DirectoryString = tslib_1.__decorate([
      (0, asn1_schema_1.AsnType)({ type: asn1_schema_1.AsnTypeTypes.Choice })
    ], DirectoryString);
    var AttributeValue = class AttributeValue extends DirectoryString {
      ia5String;
      anyValue;
      constructor(params = {}) {
        super(params);
        Object.assign(this, params);
      }
      toString() {
        return this.ia5String || (this.anyValue ? encoding_1.hex.encode(this.anyValue) : super.toString());
      }
    };
    exports.AttributeValue = AttributeValue;
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({ type: asn1_schema_1.AsnPropTypes.IA5String })
    ], AttributeValue.prototype, "ia5String", void 0);
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({ type: asn1_schema_1.AsnPropTypes.Any })
    ], AttributeValue.prototype, "anyValue", void 0);
    exports.AttributeValue = AttributeValue = tslib_1.__decorate([
      (0, asn1_schema_1.AsnType)({ type: asn1_schema_1.AsnTypeTypes.Choice })
    ], AttributeValue);
    var AttributeTypeAndValue = class {
      type = "";
      value = new AttributeValue();
      constructor(params = {}) {
        Object.assign(this, params);
      }
    };
    exports.AttributeTypeAndValue = AttributeTypeAndValue;
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({ type: asn1_schema_1.AsnPropTypes.ObjectIdentifier })
    ], AttributeTypeAndValue.prototype, "type", void 0);
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({ type: AttributeValue })
    ], AttributeTypeAndValue.prototype, "value", void 0);
    var RelativeDistinguishedName = RelativeDistinguishedName_1 = class RelativeDistinguishedName extends asn1_schema_1.AsnArray {
      constructor(items) {
        super(items);
        Object.setPrototypeOf(this, RelativeDistinguishedName_1.prototype);
      }
    };
    exports.RelativeDistinguishedName = RelativeDistinguishedName;
    exports.RelativeDistinguishedName = RelativeDistinguishedName = RelativeDistinguishedName_1 = tslib_1.__decorate([
      (0, asn1_schema_1.AsnType)({
        type: asn1_schema_1.AsnTypeTypes.Set,
        itemType: AttributeTypeAndValue
      })
    ], RelativeDistinguishedName);
    var RDNSequence = RDNSequence_1 = class RDNSequence extends asn1_schema_1.AsnArray {
      constructor(items) {
        super(items);
        Object.setPrototypeOf(this, RDNSequence_1.prototype);
      }
    };
    exports.RDNSequence = RDNSequence;
    exports.RDNSequence = RDNSequence = RDNSequence_1 = tslib_1.__decorate([
      (0, asn1_schema_1.AsnType)({
        type: asn1_schema_1.AsnTypeTypes.Sequence,
        itemType: RelativeDistinguishedName
      })
    ], RDNSequence);
    var Name = Name_1 = class Name extends RDNSequence {
      constructor(items) {
        super(items);
        Object.setPrototypeOf(this, Name_1.prototype);
      }
    };
    exports.Name = Name;
    exports.Name = Name = Name_1 = tslib_1.__decorate([
      (0, asn1_schema_1.AsnType)({ type: asn1_schema_1.AsnTypeTypes.Sequence })
    ], Name);
  }
});

// node_modules/@peculiar/asn1-x509/build/cjs/general_name.js
var require_general_name = __commonJS({
  "node_modules/@peculiar/asn1-x509/build/cjs/general_name.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.GeneralName = exports.EDIPartyName = exports.OtherName = exports.AsnIpConverter = void 0;
    var tslib_1 = (init_tslib_es6(), __toCommonJS(tslib_es6_exports));
    var asn1_schema_1 = require_cjs2();
    var ip_converter_1 = require_ip_converter();
    var name_1 = require_name();
    exports.AsnIpConverter = {
      fromASN: (value) => ip_converter_1.IpConverter.toString(asn1_schema_1.AsnOctetStringConverter.fromASN(value)),
      toASN: (value) => asn1_schema_1.AsnOctetStringConverter.toASN(ip_converter_1.IpConverter.fromString(value))
    };
    var OtherName = class {
      typeId = "";
      value = new ArrayBuffer(0);
      constructor(params = {}) {
        Object.assign(this, params);
      }
    };
    exports.OtherName = OtherName;
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({ type: asn1_schema_1.AsnPropTypes.ObjectIdentifier })
    ], OtherName.prototype, "typeId", void 0);
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({
        type: asn1_schema_1.AsnPropTypes.Any,
        context: 0
      })
    ], OtherName.prototype, "value", void 0);
    var EDIPartyName = class {
      nameAssigner;
      partyName = new name_1.DirectoryString();
      constructor(params = {}) {
        Object.assign(this, params);
      }
    };
    exports.EDIPartyName = EDIPartyName;
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({
        type: name_1.DirectoryString,
        optional: true,
        context: 0,
        implicit: true
      })
    ], EDIPartyName.prototype, "nameAssigner", void 0);
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({
        type: name_1.DirectoryString,
        context: 1,
        implicit: true
      })
    ], EDIPartyName.prototype, "partyName", void 0);
    var GeneralName = class GeneralName {
      otherName;
      rfc822Name;
      dNSName;
      x400Address;
      directoryName;
      ediPartyName;
      uniformResourceIdentifier;
      iPAddress;
      registeredID;
      constructor(params = {}) {
        Object.assign(this, params);
      }
    };
    exports.GeneralName = GeneralName;
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({
        type: OtherName,
        context: 0,
        implicit: true
      })
    ], GeneralName.prototype, "otherName", void 0);
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({
        type: asn1_schema_1.AsnPropTypes.IA5String,
        context: 1,
        implicit: true
      })
    ], GeneralName.prototype, "rfc822Name", void 0);
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({
        type: asn1_schema_1.AsnPropTypes.IA5String,
        context: 2,
        implicit: true
      })
    ], GeneralName.prototype, "dNSName", void 0);
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({
        type: asn1_schema_1.AsnPropTypes.Any,
        context: 3,
        implicit: true
      })
    ], GeneralName.prototype, "x400Address", void 0);
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({
        type: name_1.Name,
        context: 4,
        implicit: false
      })
    ], GeneralName.prototype, "directoryName", void 0);
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({
        type: EDIPartyName,
        context: 5
      })
    ], GeneralName.prototype, "ediPartyName", void 0);
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({
        type: asn1_schema_1.AsnPropTypes.IA5String,
        context: 6,
        implicit: true
      })
    ], GeneralName.prototype, "uniformResourceIdentifier", void 0);
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({
        type: asn1_schema_1.AsnPropTypes.OctetString,
        context: 7,
        implicit: true,
        converter: exports.AsnIpConverter
      })
    ], GeneralName.prototype, "iPAddress", void 0);
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({
        type: asn1_schema_1.AsnPropTypes.ObjectIdentifier,
        context: 8,
        implicit: true
      })
    ], GeneralName.prototype, "registeredID", void 0);
    exports.GeneralName = GeneralName = tslib_1.__decorate([
      (0, asn1_schema_1.AsnType)({ type: asn1_schema_1.AsnTypeTypes.Choice })
    ], GeneralName);
  }
});

// node_modules/@peculiar/asn1-x509/build/cjs/object_identifiers.js
var require_object_identifiers = __commonJS({
  "node_modules/@peculiar/asn1-x509/build/cjs/object_identifiers.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.id_alg_unsigned = exports.id_ce = exports.id_ad_caRepository = exports.id_ad_timeStamping = exports.id_ad_caIssuers = exports.id_ad_ocsp = exports.id_qt_unotice = exports.id_qt_csp = exports.id_ad = exports.id_kp = exports.id_qt = exports.id_pe = exports.id_pkix = void 0;
    exports.id_pkix = "1.3.6.1.5.5.7";
    exports.id_pe = `${exports.id_pkix}.1`;
    exports.id_qt = `${exports.id_pkix}.2`;
    exports.id_kp = `${exports.id_pkix}.3`;
    exports.id_ad = `${exports.id_pkix}.48`;
    exports.id_qt_csp = `${exports.id_qt}.1`;
    exports.id_qt_unotice = `${exports.id_qt}.2`;
    exports.id_ad_ocsp = `${exports.id_ad}.1`;
    exports.id_ad_caIssuers = `${exports.id_ad}.2`;
    exports.id_ad_timeStamping = `${exports.id_ad}.3`;
    exports.id_ad_caRepository = `${exports.id_ad}.5`;
    exports.id_ce = "2.5.29";
    exports.id_alg_unsigned = "1.3.6.1.5.5.7.6.36";
  }
});

// node_modules/@peculiar/asn1-x509/build/cjs/extensions/authority_information_access.js
var require_authority_information_access = __commonJS({
  "node_modules/@peculiar/asn1-x509/build/cjs/extensions/authority_information_access.js"(exports) {
    "use strict";
    var AuthorityInfoAccessSyntax_1;
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.AuthorityInfoAccessSyntax = exports.AccessDescription = exports.id_pe_authorityInfoAccess = void 0;
    var tslib_1 = (init_tslib_es6(), __toCommonJS(tslib_es6_exports));
    var asn1_schema_1 = require_cjs2();
    var general_name_1 = require_general_name();
    var object_identifiers_1 = require_object_identifiers();
    exports.id_pe_authorityInfoAccess = `${object_identifiers_1.id_pe}.1`;
    var AccessDescription = class {
      accessMethod = "";
      accessLocation = new general_name_1.GeneralName();
      constructor(params = {}) {
        Object.assign(this, params);
      }
    };
    exports.AccessDescription = AccessDescription;
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({ type: asn1_schema_1.AsnPropTypes.ObjectIdentifier })
    ], AccessDescription.prototype, "accessMethod", void 0);
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({ type: general_name_1.GeneralName })
    ], AccessDescription.prototype, "accessLocation", void 0);
    var AuthorityInfoAccessSyntax = AuthorityInfoAccessSyntax_1 = class AuthorityInfoAccessSyntax extends asn1_schema_1.AsnArray {
      constructor(items) {
        super(items);
        Object.setPrototypeOf(this, AuthorityInfoAccessSyntax_1.prototype);
      }
    };
    exports.AuthorityInfoAccessSyntax = AuthorityInfoAccessSyntax;
    exports.AuthorityInfoAccessSyntax = AuthorityInfoAccessSyntax = AuthorityInfoAccessSyntax_1 = tslib_1.__decorate([
      (0, asn1_schema_1.AsnType)({
        type: asn1_schema_1.AsnTypeTypes.Sequence,
        itemType: AccessDescription
      })
    ], AuthorityInfoAccessSyntax);
  }
});

// node_modules/@peculiar/asn1-x509/build/cjs/extensions/authority_key_identifier.js
var require_authority_key_identifier = __commonJS({
  "node_modules/@peculiar/asn1-x509/build/cjs/extensions/authority_key_identifier.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.AuthorityKeyIdentifier = exports.KeyIdentifier = exports.id_ce_authorityKeyIdentifier = void 0;
    var tslib_1 = (init_tslib_es6(), __toCommonJS(tslib_es6_exports));
    var asn1_schema_1 = require_cjs2();
    var general_name_1 = require_general_name();
    var object_identifiers_1 = require_object_identifiers();
    exports.id_ce_authorityKeyIdentifier = `${object_identifiers_1.id_ce}.35`;
    var KeyIdentifier = class extends asn1_schema_1.OctetString {
    };
    exports.KeyIdentifier = KeyIdentifier;
    var AuthorityKeyIdentifier = class {
      keyIdentifier;
      authorityCertIssuer;
      authorityCertSerialNumber;
      constructor(params = {}) {
        if (params) {
          Object.assign(this, params);
        }
      }
    };
    exports.AuthorityKeyIdentifier = AuthorityKeyIdentifier;
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({
        type: KeyIdentifier,
        context: 0,
        optional: true,
        implicit: true
      })
    ], AuthorityKeyIdentifier.prototype, "keyIdentifier", void 0);
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({
        type: general_name_1.GeneralName,
        context: 1,
        optional: true,
        implicit: true,
        repeated: "sequence"
      })
    ], AuthorityKeyIdentifier.prototype, "authorityCertIssuer", void 0);
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({
        type: asn1_schema_1.AsnPropTypes.Integer,
        context: 2,
        optional: true,
        implicit: true,
        converter: asn1_schema_1.AsnIntegerArrayBufferConverter
      })
    ], AuthorityKeyIdentifier.prototype, "authorityCertSerialNumber", void 0);
  }
});

// node_modules/@peculiar/asn1-x509/build/cjs/extensions/basic_constraints.js
var require_basic_constraints = __commonJS({
  "node_modules/@peculiar/asn1-x509/build/cjs/extensions/basic_constraints.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.BasicConstraints = exports.id_ce_basicConstraints = void 0;
    var tslib_1 = (init_tslib_es6(), __toCommonJS(tslib_es6_exports));
    var asn1_schema_1 = require_cjs2();
    var object_identifiers_1 = require_object_identifiers();
    exports.id_ce_basicConstraints = `${object_identifiers_1.id_ce}.19`;
    var BasicConstraints = class {
      cA = false;
      pathLenConstraint;
      constructor(params = {}) {
        Object.assign(this, params);
      }
    };
    exports.BasicConstraints = BasicConstraints;
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({
        type: asn1_schema_1.AsnPropTypes.Boolean,
        defaultValue: false
      })
    ], BasicConstraints.prototype, "cA", void 0);
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({
        type: asn1_schema_1.AsnPropTypes.Integer,
        optional: true
      })
    ], BasicConstraints.prototype, "pathLenConstraint", void 0);
  }
});

// node_modules/@peculiar/asn1-x509/build/cjs/general_names.js
var require_general_names = __commonJS({
  "node_modules/@peculiar/asn1-x509/build/cjs/general_names.js"(exports) {
    "use strict";
    var GeneralNames_1;
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.GeneralNames = void 0;
    var tslib_1 = (init_tslib_es6(), __toCommonJS(tslib_es6_exports));
    var asn1_schema_1 = require_cjs2();
    var general_name_1 = require_general_name();
    var GeneralNames = GeneralNames_1 = class GeneralNames extends asn1_schema_1.AsnArray {
      constructor(items) {
        super(items);
        Object.setPrototypeOf(this, GeneralNames_1.prototype);
      }
    };
    exports.GeneralNames = GeneralNames;
    exports.GeneralNames = GeneralNames = GeneralNames_1 = tslib_1.__decorate([
      (0, asn1_schema_1.AsnType)({
        type: asn1_schema_1.AsnTypeTypes.Sequence,
        itemType: general_name_1.GeneralName
      })
    ], GeneralNames);
  }
});

// node_modules/@peculiar/asn1-x509/build/cjs/extensions/certificate_issuer.js
var require_certificate_issuer = __commonJS({
  "node_modules/@peculiar/asn1-x509/build/cjs/extensions/certificate_issuer.js"(exports) {
    "use strict";
    var CertificateIssuer_1;
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.CertificateIssuer = exports.id_ce_certificateIssuer = void 0;
    var tslib_1 = (init_tslib_es6(), __toCommonJS(tslib_es6_exports));
    var asn1_schema_1 = require_cjs2();
    var general_names_1 = require_general_names();
    var object_identifiers_1 = require_object_identifiers();
    exports.id_ce_certificateIssuer = `${object_identifiers_1.id_ce}.29`;
    var CertificateIssuer = CertificateIssuer_1 = class CertificateIssuer extends general_names_1.GeneralNames {
      constructor(items) {
        super(items);
        Object.setPrototypeOf(this, CertificateIssuer_1.prototype);
      }
    };
    exports.CertificateIssuer = CertificateIssuer;
    exports.CertificateIssuer = CertificateIssuer = CertificateIssuer_1 = tslib_1.__decorate([
      (0, asn1_schema_1.AsnType)({ type: asn1_schema_1.AsnTypeTypes.Sequence })
    ], CertificateIssuer);
  }
});

// node_modules/@peculiar/asn1-x509/build/cjs/extensions/certificate_policies.js
var require_certificate_policies = __commonJS({
  "node_modules/@peculiar/asn1-x509/build/cjs/extensions/certificate_policies.js"(exports) {
    "use strict";
    var CertificatePolicies_1;
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.CertificatePolicies = exports.PolicyInformation = exports.PolicyQualifierInfo = exports.Qualifier = exports.UserNotice = exports.NoticeReference = exports.DisplayText = exports.id_ce_certificatePolicies_anyPolicy = exports.id_ce_certificatePolicies = void 0;
    var tslib_1 = (init_tslib_es6(), __toCommonJS(tslib_es6_exports));
    var asn1_schema_1 = require_cjs2();
    var object_identifiers_1 = require_object_identifiers();
    exports.id_ce_certificatePolicies = `${object_identifiers_1.id_ce}.32`;
    exports.id_ce_certificatePolicies_anyPolicy = `${exports.id_ce_certificatePolicies}.0`;
    var DisplayText = class DisplayText {
      ia5String;
      visibleString;
      bmpString;
      utf8String;
      constructor(params = {}) {
        Object.assign(this, params);
      }
      toString() {
        return this.ia5String || this.visibleString || this.bmpString || this.utf8String || "";
      }
    };
    exports.DisplayText = DisplayText;
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({ type: asn1_schema_1.AsnPropTypes.IA5String })
    ], DisplayText.prototype, "ia5String", void 0);
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({ type: asn1_schema_1.AsnPropTypes.VisibleString })
    ], DisplayText.prototype, "visibleString", void 0);
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({ type: asn1_schema_1.AsnPropTypes.BmpString })
    ], DisplayText.prototype, "bmpString", void 0);
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({ type: asn1_schema_1.AsnPropTypes.Utf8String })
    ], DisplayText.prototype, "utf8String", void 0);
    exports.DisplayText = DisplayText = tslib_1.__decorate([
      (0, asn1_schema_1.AsnType)({ type: asn1_schema_1.AsnTypeTypes.Choice })
    ], DisplayText);
    var NoticeReference = class {
      organization = new DisplayText();
      noticeNumbers = [];
      constructor(params = {}) {
        Object.assign(this, params);
      }
    };
    exports.NoticeReference = NoticeReference;
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({ type: DisplayText })
    ], NoticeReference.prototype, "organization", void 0);
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({
        type: asn1_schema_1.AsnPropTypes.Integer,
        repeated: "sequence"
      })
    ], NoticeReference.prototype, "noticeNumbers", void 0);
    var UserNotice = class {
      noticeRef;
      explicitText;
      constructor(params = {}) {
        Object.assign(this, params);
      }
    };
    exports.UserNotice = UserNotice;
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({
        type: NoticeReference,
        optional: true
      })
    ], UserNotice.prototype, "noticeRef", void 0);
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({
        type: DisplayText,
        optional: true
      })
    ], UserNotice.prototype, "explicitText", void 0);
    var Qualifier = class Qualifier {
      cPSuri;
      userNotice;
      constructor(params = {}) {
        Object.assign(this, params);
      }
    };
    exports.Qualifier = Qualifier;
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({ type: asn1_schema_1.AsnPropTypes.IA5String })
    ], Qualifier.prototype, "cPSuri", void 0);
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({ type: UserNotice })
    ], Qualifier.prototype, "userNotice", void 0);
    exports.Qualifier = Qualifier = tslib_1.__decorate([
      (0, asn1_schema_1.AsnType)({ type: asn1_schema_1.AsnTypeTypes.Choice })
    ], Qualifier);
    var PolicyQualifierInfo = class {
      policyQualifierId = "";
      qualifier = new ArrayBuffer(0);
      constructor(params = {}) {
        Object.assign(this, params);
      }
    };
    exports.PolicyQualifierInfo = PolicyQualifierInfo;
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({ type: asn1_schema_1.AsnPropTypes.ObjectIdentifier })
    ], PolicyQualifierInfo.prototype, "policyQualifierId", void 0);
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({ type: asn1_schema_1.AsnPropTypes.Any })
    ], PolicyQualifierInfo.prototype, "qualifier", void 0);
    var PolicyInformation = class {
      policyIdentifier = "";
      policyQualifiers;
      constructor(params = {}) {
        Object.assign(this, params);
      }
    };
    exports.PolicyInformation = PolicyInformation;
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({ type: asn1_schema_1.AsnPropTypes.ObjectIdentifier })
    ], PolicyInformation.prototype, "policyIdentifier", void 0);
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({
        type: PolicyQualifierInfo,
        repeated: "sequence",
        optional: true
      })
    ], PolicyInformation.prototype, "policyQualifiers", void 0);
    var CertificatePolicies = CertificatePolicies_1 = class CertificatePolicies extends asn1_schema_1.AsnArray {
      constructor(items) {
        super(items);
        Object.setPrototypeOf(this, CertificatePolicies_1.prototype);
      }
    };
    exports.CertificatePolicies = CertificatePolicies;
    exports.CertificatePolicies = CertificatePolicies = CertificatePolicies_1 = tslib_1.__decorate([
      (0, asn1_schema_1.AsnType)({
        type: asn1_schema_1.AsnTypeTypes.Sequence,
        itemType: PolicyInformation
      })
    ], CertificatePolicies);
  }
});

// node_modules/@peculiar/asn1-x509/build/cjs/extensions/crl_number.js
var require_crl_number = __commonJS({
  "node_modules/@peculiar/asn1-x509/build/cjs/extensions/crl_number.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.CRLNumber = exports.id_ce_cRLNumber = void 0;
    var tslib_1 = (init_tslib_es6(), __toCommonJS(tslib_es6_exports));
    var asn1_schema_1 = require_cjs2();
    var object_identifiers_1 = require_object_identifiers();
    exports.id_ce_cRLNumber = `${object_identifiers_1.id_ce}.20`;
    var CRLNumber = class CRLNumber {
      value;
      constructor(value = 0) {
        this.value = value;
      }
    };
    exports.CRLNumber = CRLNumber;
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({ type: asn1_schema_1.AsnPropTypes.Integer })
    ], CRLNumber.prototype, "value", void 0);
    exports.CRLNumber = CRLNumber = tslib_1.__decorate([
      (0, asn1_schema_1.AsnType)({ type: asn1_schema_1.AsnTypeTypes.Choice })
    ], CRLNumber);
  }
});

// node_modules/@peculiar/asn1-x509/build/cjs/extensions/crl_delta_indicator.js
var require_crl_delta_indicator = __commonJS({
  "node_modules/@peculiar/asn1-x509/build/cjs/extensions/crl_delta_indicator.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.BaseCRLNumber = exports.id_ce_deltaCRLIndicator = void 0;
    var tslib_1 = (init_tslib_es6(), __toCommonJS(tslib_es6_exports));
    var asn1_schema_1 = require_cjs2();
    var object_identifiers_1 = require_object_identifiers();
    var crl_number_1 = require_crl_number();
    exports.id_ce_deltaCRLIndicator = `${object_identifiers_1.id_ce}.27`;
    var BaseCRLNumber = class BaseCRLNumber extends crl_number_1.CRLNumber {
    };
    exports.BaseCRLNumber = BaseCRLNumber;
    exports.BaseCRLNumber = BaseCRLNumber = tslib_1.__decorate([
      (0, asn1_schema_1.AsnType)({ type: asn1_schema_1.AsnTypeTypes.Choice })
    ], BaseCRLNumber);
  }
});

// node_modules/@peculiar/asn1-x509/build/cjs/extensions/crl_distribution_points.js
var require_crl_distribution_points = __commonJS({
  "node_modules/@peculiar/asn1-x509/build/cjs/extensions/crl_distribution_points.js"(exports) {
    "use strict";
    var CRLDistributionPoints_1;
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.CRLDistributionPoints = exports.DistributionPoint = exports.DistributionPointName = exports.Reason = exports.ReasonFlags = exports.id_ce_cRLDistributionPoints = void 0;
    var tslib_1 = (init_tslib_es6(), __toCommonJS(tslib_es6_exports));
    var asn1_schema_1 = require_cjs2();
    var name_1 = require_name();
    var general_name_1 = require_general_name();
    var object_identifiers_1 = require_object_identifiers();
    exports.id_ce_cRLDistributionPoints = `${object_identifiers_1.id_ce}.31`;
    var ReasonFlags;
    (function(ReasonFlags2) {
      ReasonFlags2[ReasonFlags2["unused"] = 1] = "unused";
      ReasonFlags2[ReasonFlags2["keyCompromise"] = 2] = "keyCompromise";
      ReasonFlags2[ReasonFlags2["cACompromise"] = 4] = "cACompromise";
      ReasonFlags2[ReasonFlags2["affiliationChanged"] = 8] = "affiliationChanged";
      ReasonFlags2[ReasonFlags2["superseded"] = 16] = "superseded";
      ReasonFlags2[ReasonFlags2["cessationOfOperation"] = 32] = "cessationOfOperation";
      ReasonFlags2[ReasonFlags2["certificateHold"] = 64] = "certificateHold";
      ReasonFlags2[ReasonFlags2["privilegeWithdrawn"] = 128] = "privilegeWithdrawn";
      ReasonFlags2[ReasonFlags2["aACompromise"] = 256] = "aACompromise";
    })(ReasonFlags || (exports.ReasonFlags = ReasonFlags = {}));
    var Reason = class extends asn1_schema_1.BitString {
      toJSON() {
        const res = [];
        const flags = this.toNumber();
        if (flags & ReasonFlags.aACompromise) {
          res.push("aACompromise");
        }
        if (flags & ReasonFlags.affiliationChanged) {
          res.push("affiliationChanged");
        }
        if (flags & ReasonFlags.cACompromise) {
          res.push("cACompromise");
        }
        if (flags & ReasonFlags.certificateHold) {
          res.push("certificateHold");
        }
        if (flags & ReasonFlags.cessationOfOperation) {
          res.push("cessationOfOperation");
        }
        if (flags & ReasonFlags.keyCompromise) {
          res.push("keyCompromise");
        }
        if (flags & ReasonFlags.privilegeWithdrawn) {
          res.push("privilegeWithdrawn");
        }
        if (flags & ReasonFlags.superseded) {
          res.push("superseded");
        }
        if (flags & ReasonFlags.unused) {
          res.push("unused");
        }
        return res;
      }
      toString() {
        return `[${this.toJSON().join(", ")}]`;
      }
    };
    exports.Reason = Reason;
    var DistributionPointName = class DistributionPointName {
      fullName;
      nameRelativeToCRLIssuer;
      constructor(params = {}) {
        Object.assign(this, params);
      }
    };
    exports.DistributionPointName = DistributionPointName;
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({
        type: general_name_1.GeneralName,
        context: 0,
        repeated: "sequence",
        implicit: true
      })
    ], DistributionPointName.prototype, "fullName", void 0);
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({
        type: name_1.RelativeDistinguishedName,
        context: 1,
        implicit: true
      })
    ], DistributionPointName.prototype, "nameRelativeToCRLIssuer", void 0);
    exports.DistributionPointName = DistributionPointName = tslib_1.__decorate([
      (0, asn1_schema_1.AsnType)({ type: asn1_schema_1.AsnTypeTypes.Choice })
    ], DistributionPointName);
    var DistributionPoint = class {
      distributionPoint;
      reasons;
      cRLIssuer;
      constructor(params = {}) {
        Object.assign(this, params);
      }
    };
    exports.DistributionPoint = DistributionPoint;
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({
        type: DistributionPointName,
        context: 0,
        optional: true
      })
    ], DistributionPoint.prototype, "distributionPoint", void 0);
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({
        type: Reason,
        context: 1,
        optional: true,
        implicit: true
      })
    ], DistributionPoint.prototype, "reasons", void 0);
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({
        type: general_name_1.GeneralName,
        context: 2,
        optional: true,
        repeated: "sequence",
        implicit: true
      })
    ], DistributionPoint.prototype, "cRLIssuer", void 0);
    var CRLDistributionPoints = CRLDistributionPoints_1 = class CRLDistributionPoints extends asn1_schema_1.AsnArray {
      constructor(items) {
        super(items);
        Object.setPrototypeOf(this, CRLDistributionPoints_1.prototype);
      }
    };
    exports.CRLDistributionPoints = CRLDistributionPoints;
    exports.CRLDistributionPoints = CRLDistributionPoints = CRLDistributionPoints_1 = tslib_1.__decorate([
      (0, asn1_schema_1.AsnType)({
        type: asn1_schema_1.AsnTypeTypes.Sequence,
        itemType: DistributionPoint
      })
    ], CRLDistributionPoints);
  }
});

// node_modules/@peculiar/asn1-x509/build/cjs/extensions/crl_freshest.js
var require_crl_freshest = __commonJS({
  "node_modules/@peculiar/asn1-x509/build/cjs/extensions/crl_freshest.js"(exports) {
    "use strict";
    var FreshestCRL_1;
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.FreshestCRL = exports.id_ce_freshestCRL = void 0;
    var tslib_1 = (init_tslib_es6(), __toCommonJS(tslib_es6_exports));
    var asn1_schema_1 = require_cjs2();
    var object_identifiers_1 = require_object_identifiers();
    var crl_distribution_points_1 = require_crl_distribution_points();
    exports.id_ce_freshestCRL = `${object_identifiers_1.id_ce}.46`;
    var FreshestCRL = FreshestCRL_1 = class FreshestCRL extends crl_distribution_points_1.CRLDistributionPoints {
      constructor(items) {
        super(items);
        Object.setPrototypeOf(this, FreshestCRL_1.prototype);
      }
    };
    exports.FreshestCRL = FreshestCRL;
    exports.FreshestCRL = FreshestCRL = FreshestCRL_1 = tslib_1.__decorate([
      (0, asn1_schema_1.AsnType)({
        type: asn1_schema_1.AsnTypeTypes.Sequence,
        itemType: crl_distribution_points_1.DistributionPoint
      })
    ], FreshestCRL);
  }
});

// node_modules/@peculiar/asn1-x509/build/cjs/extensions/crl_issuing_distribution_point.js
var require_crl_issuing_distribution_point = __commonJS({
  "node_modules/@peculiar/asn1-x509/build/cjs/extensions/crl_issuing_distribution_point.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.IssuingDistributionPoint = exports.id_ce_issuingDistributionPoint = void 0;
    var tslib_1 = (init_tslib_es6(), __toCommonJS(tslib_es6_exports));
    var asn1_schema_1 = require_cjs2();
    var object_identifiers_1 = require_object_identifiers();
    var crl_distribution_points_1 = require_crl_distribution_points();
    exports.id_ce_issuingDistributionPoint = `${object_identifiers_1.id_ce}.28`;
    var IssuingDistributionPoint = class _IssuingDistributionPoint {
      static ONLY = false;
      distributionPoint;
      onlyContainsUserCerts = _IssuingDistributionPoint.ONLY;
      onlyContainsCACerts = _IssuingDistributionPoint.ONLY;
      onlySomeReasons;
      indirectCRL = _IssuingDistributionPoint.ONLY;
      onlyContainsAttributeCerts = _IssuingDistributionPoint.ONLY;
      constructor(params = {}) {
        Object.assign(this, params);
      }
    };
    exports.IssuingDistributionPoint = IssuingDistributionPoint;
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({
        type: crl_distribution_points_1.DistributionPointName,
        context: 0,
        optional: true
      })
    ], IssuingDistributionPoint.prototype, "distributionPoint", void 0);
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({
        type: asn1_schema_1.AsnPropTypes.Boolean,
        context: 1,
        defaultValue: IssuingDistributionPoint.ONLY,
        implicit: true
      })
    ], IssuingDistributionPoint.prototype, "onlyContainsUserCerts", void 0);
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({
        type: asn1_schema_1.AsnPropTypes.Boolean,
        context: 2,
        defaultValue: IssuingDistributionPoint.ONLY,
        implicit: true
      })
    ], IssuingDistributionPoint.prototype, "onlyContainsCACerts", void 0);
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({
        type: crl_distribution_points_1.Reason,
        context: 3,
        optional: true,
        implicit: true
      })
    ], IssuingDistributionPoint.prototype, "onlySomeReasons", void 0);
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({
        type: asn1_schema_1.AsnPropTypes.Boolean,
        context: 4,
        defaultValue: IssuingDistributionPoint.ONLY,
        implicit: true
      })
    ], IssuingDistributionPoint.prototype, "indirectCRL", void 0);
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({
        type: asn1_schema_1.AsnPropTypes.Boolean,
        context: 5,
        defaultValue: IssuingDistributionPoint.ONLY,
        implicit: true
      })
    ], IssuingDistributionPoint.prototype, "onlyContainsAttributeCerts", void 0);
  }
});

// node_modules/@peculiar/asn1-x509/build/cjs/extensions/crl_reason.js
var require_crl_reason = __commonJS({
  "node_modules/@peculiar/asn1-x509/build/cjs/extensions/crl_reason.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.CRLReason = exports.CRLReasons = exports.id_ce_cRLReasons = void 0;
    var tslib_1 = (init_tslib_es6(), __toCommonJS(tslib_es6_exports));
    var asn1_schema_1 = require_cjs2();
    var object_identifiers_1 = require_object_identifiers();
    exports.id_ce_cRLReasons = `${object_identifiers_1.id_ce}.21`;
    var CRLReasons;
    (function(CRLReasons2) {
      CRLReasons2[CRLReasons2["unspecified"] = 0] = "unspecified";
      CRLReasons2[CRLReasons2["keyCompromise"] = 1] = "keyCompromise";
      CRLReasons2[CRLReasons2["cACompromise"] = 2] = "cACompromise";
      CRLReasons2[CRLReasons2["affiliationChanged"] = 3] = "affiliationChanged";
      CRLReasons2[CRLReasons2["superseded"] = 4] = "superseded";
      CRLReasons2[CRLReasons2["cessationOfOperation"] = 5] = "cessationOfOperation";
      CRLReasons2[CRLReasons2["certificateHold"] = 6] = "certificateHold";
      CRLReasons2[CRLReasons2["removeFromCRL"] = 8] = "removeFromCRL";
      CRLReasons2[CRLReasons2["privilegeWithdrawn"] = 9] = "privilegeWithdrawn";
      CRLReasons2[CRLReasons2["aACompromise"] = 10] = "aACompromise";
    })(CRLReasons || (exports.CRLReasons = CRLReasons = {}));
    var CRLReason = class CRLReason {
      reason = CRLReasons.unspecified;
      constructor(reason = CRLReasons.unspecified) {
        this.reason = reason;
      }
      toJSON() {
        return CRLReasons[this.reason];
      }
      toString() {
        return this.toJSON();
      }
    };
    exports.CRLReason = CRLReason;
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({ type: asn1_schema_1.AsnPropTypes.Enumerated })
    ], CRLReason.prototype, "reason", void 0);
    exports.CRLReason = CRLReason = tslib_1.__decorate([
      (0, asn1_schema_1.AsnType)({ type: asn1_schema_1.AsnTypeTypes.Choice })
    ], CRLReason);
  }
});

// node_modules/@peculiar/asn1-x509/build/cjs/extensions/extended_key_usage.js
var require_extended_key_usage = __commonJS({
  "node_modules/@peculiar/asn1-x509/build/cjs/extensions/extended_key_usage.js"(exports) {
    "use strict";
    var ExtendedKeyUsage_1;
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.id_kp_OCSPSigning = exports.id_kp_timeStamping = exports.id_kp_emailProtection = exports.id_kp_codeSigning = exports.id_kp_clientAuth = exports.id_kp_serverAuth = exports.anyExtendedKeyUsage = exports.ExtendedKeyUsage = exports.id_ce_extKeyUsage = void 0;
    var tslib_1 = (init_tslib_es6(), __toCommonJS(tslib_es6_exports));
    var asn1_schema_1 = require_cjs2();
    var object_identifiers_1 = require_object_identifiers();
    exports.id_ce_extKeyUsage = `${object_identifiers_1.id_ce}.37`;
    var ExtendedKeyUsage = ExtendedKeyUsage_1 = class ExtendedKeyUsage extends asn1_schema_1.AsnArray {
      constructor(items) {
        super(items);
        Object.setPrototypeOf(this, ExtendedKeyUsage_1.prototype);
      }
    };
    exports.ExtendedKeyUsage = ExtendedKeyUsage;
    exports.ExtendedKeyUsage = ExtendedKeyUsage = ExtendedKeyUsage_1 = tslib_1.__decorate([
      (0, asn1_schema_1.AsnType)({
        type: asn1_schema_1.AsnTypeTypes.Sequence,
        itemType: asn1_schema_1.AsnPropTypes.ObjectIdentifier
      })
    ], ExtendedKeyUsage);
    exports.anyExtendedKeyUsage = `${exports.id_ce_extKeyUsage}.0`;
    exports.id_kp_serverAuth = `${object_identifiers_1.id_kp}.1`;
    exports.id_kp_clientAuth = `${object_identifiers_1.id_kp}.2`;
    exports.id_kp_codeSigning = `${object_identifiers_1.id_kp}.3`;
    exports.id_kp_emailProtection = `${object_identifiers_1.id_kp}.4`;
    exports.id_kp_timeStamping = `${object_identifiers_1.id_kp}.8`;
    exports.id_kp_OCSPSigning = `${object_identifiers_1.id_kp}.9`;
  }
});

// node_modules/@peculiar/asn1-x509/build/cjs/extensions/inhibit_any_policy.js
var require_inhibit_any_policy = __commonJS({
  "node_modules/@peculiar/asn1-x509/build/cjs/extensions/inhibit_any_policy.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.InhibitAnyPolicy = exports.id_ce_inhibitAnyPolicy = void 0;
    var tslib_1 = (init_tslib_es6(), __toCommonJS(tslib_es6_exports));
    var asn1_schema_1 = require_cjs2();
    var object_identifiers_1 = require_object_identifiers();
    exports.id_ce_inhibitAnyPolicy = `${object_identifiers_1.id_ce}.54`;
    var InhibitAnyPolicy = class InhibitAnyPolicy {
      value;
      constructor(value = new ArrayBuffer(0)) {
        this.value = value;
      }
    };
    exports.InhibitAnyPolicy = InhibitAnyPolicy;
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({
        type: asn1_schema_1.AsnPropTypes.Integer,
        converter: asn1_schema_1.AsnIntegerArrayBufferConverter
      })
    ], InhibitAnyPolicy.prototype, "value", void 0);
    exports.InhibitAnyPolicy = InhibitAnyPolicy = tslib_1.__decorate([
      (0, asn1_schema_1.AsnType)({ type: asn1_schema_1.AsnTypeTypes.Choice })
    ], InhibitAnyPolicy);
  }
});

// node_modules/@peculiar/asn1-x509/build/cjs/extensions/invalidity_date.js
var require_invalidity_date = __commonJS({
  "node_modules/@peculiar/asn1-x509/build/cjs/extensions/invalidity_date.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.InvalidityDate = exports.id_ce_invalidityDate = void 0;
    var tslib_1 = (init_tslib_es6(), __toCommonJS(tslib_es6_exports));
    var asn1_schema_1 = require_cjs2();
    var object_identifiers_1 = require_object_identifiers();
    exports.id_ce_invalidityDate = `${object_identifiers_1.id_ce}.24`;
    var InvalidityDate = class InvalidityDate {
      value = /* @__PURE__ */ new Date();
      constructor(value) {
        if (value) {
          this.value = value;
        }
      }
    };
    exports.InvalidityDate = InvalidityDate;
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({ type: asn1_schema_1.AsnPropTypes.GeneralizedTime })
    ], InvalidityDate.prototype, "value", void 0);
    exports.InvalidityDate = InvalidityDate = tslib_1.__decorate([
      (0, asn1_schema_1.AsnType)({ type: asn1_schema_1.AsnTypeTypes.Choice })
    ], InvalidityDate);
  }
});

// node_modules/@peculiar/asn1-x509/build/cjs/extensions/issuer_alternative_name.js
var require_issuer_alternative_name = __commonJS({
  "node_modules/@peculiar/asn1-x509/build/cjs/extensions/issuer_alternative_name.js"(exports) {
    "use strict";
    var IssueAlternativeName_1;
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.IssueAlternativeName = exports.id_ce_issuerAltName = void 0;
    var tslib_1 = (init_tslib_es6(), __toCommonJS(tslib_es6_exports));
    var asn1_schema_1 = require_cjs2();
    var general_names_1 = require_general_names();
    var object_identifiers_1 = require_object_identifiers();
    exports.id_ce_issuerAltName = `${object_identifiers_1.id_ce}.18`;
    var IssueAlternativeName = IssueAlternativeName_1 = class IssueAlternativeName extends general_names_1.GeneralNames {
      constructor(items) {
        super(items);
        Object.setPrototypeOf(this, IssueAlternativeName_1.prototype);
      }
    };
    exports.IssueAlternativeName = IssueAlternativeName;
    exports.IssueAlternativeName = IssueAlternativeName = IssueAlternativeName_1 = tslib_1.__decorate([
      (0, asn1_schema_1.AsnType)({ type: asn1_schema_1.AsnTypeTypes.Sequence })
    ], IssueAlternativeName);
  }
});

// node_modules/@peculiar/asn1-x509/build/cjs/extensions/key_usage.js
var require_key_usage = __commonJS({
  "node_modules/@peculiar/asn1-x509/build/cjs/extensions/key_usage.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.KeyUsage = exports.KeyUsageFlags = exports.id_ce_keyUsage = void 0;
    var asn1_schema_1 = require_cjs2();
    var object_identifiers_1 = require_object_identifiers();
    exports.id_ce_keyUsage = `${object_identifiers_1.id_ce}.15`;
    var KeyUsageFlags2;
    (function(KeyUsageFlags3) {
      KeyUsageFlags3[KeyUsageFlags3["digitalSignature"] = 1] = "digitalSignature";
      KeyUsageFlags3[KeyUsageFlags3["nonRepudiation"] = 2] = "nonRepudiation";
      KeyUsageFlags3[KeyUsageFlags3["keyEncipherment"] = 4] = "keyEncipherment";
      KeyUsageFlags3[KeyUsageFlags3["dataEncipherment"] = 8] = "dataEncipherment";
      KeyUsageFlags3[KeyUsageFlags3["keyAgreement"] = 16] = "keyAgreement";
      KeyUsageFlags3[KeyUsageFlags3["keyCertSign"] = 32] = "keyCertSign";
      KeyUsageFlags3[KeyUsageFlags3["cRLSign"] = 64] = "cRLSign";
      KeyUsageFlags3[KeyUsageFlags3["encipherOnly"] = 128] = "encipherOnly";
      KeyUsageFlags3[KeyUsageFlags3["decipherOnly"] = 256] = "decipherOnly";
    })(KeyUsageFlags2 || (exports.KeyUsageFlags = KeyUsageFlags2 = {}));
    var KeyUsage = class extends asn1_schema_1.BitString {
      toJSON() {
        const flag = this.toNumber();
        const res = [];
        if (flag & KeyUsageFlags2.cRLSign) {
          res.push("crlSign");
        }
        if (flag & KeyUsageFlags2.dataEncipherment) {
          res.push("dataEncipherment");
        }
        if (flag & KeyUsageFlags2.decipherOnly) {
          res.push("decipherOnly");
        }
        if (flag & KeyUsageFlags2.digitalSignature) {
          res.push("digitalSignature");
        }
        if (flag & KeyUsageFlags2.encipherOnly) {
          res.push("encipherOnly");
        }
        if (flag & KeyUsageFlags2.keyAgreement) {
          res.push("keyAgreement");
        }
        if (flag & KeyUsageFlags2.keyCertSign) {
          res.push("keyCertSign");
        }
        if (flag & KeyUsageFlags2.keyEncipherment) {
          res.push("keyEncipherment");
        }
        if (flag & KeyUsageFlags2.nonRepudiation) {
          res.push("nonRepudiation");
        }
        return res;
      }
      toString() {
        return `[${this.toJSON().join(", ")}]`;
      }
    };
    exports.KeyUsage = KeyUsage;
  }
});

// node_modules/@peculiar/asn1-x509/build/cjs/extensions/name_constraints.js
var require_name_constraints = __commonJS({
  "node_modules/@peculiar/asn1-x509/build/cjs/extensions/name_constraints.js"(exports) {
    "use strict";
    var GeneralSubtrees_1;
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.NameConstraints = exports.GeneralSubtrees = exports.GeneralSubtree = exports.id_ce_nameConstraints = void 0;
    var tslib_1 = (init_tslib_es6(), __toCommonJS(tslib_es6_exports));
    var asn1_schema_1 = require_cjs2();
    var general_name_1 = require_general_name();
    var object_identifiers_1 = require_object_identifiers();
    exports.id_ce_nameConstraints = `${object_identifiers_1.id_ce}.30`;
    var GeneralSubtree = class {
      base = new general_name_1.GeneralName();
      minimum = 0;
      maximum;
      constructor(params = {}) {
        Object.assign(this, params);
      }
    };
    exports.GeneralSubtree = GeneralSubtree;
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({ type: general_name_1.GeneralName })
    ], GeneralSubtree.prototype, "base", void 0);
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({
        type: asn1_schema_1.AsnPropTypes.Integer,
        context: 0,
        defaultValue: 0,
        implicit: true
      })
    ], GeneralSubtree.prototype, "minimum", void 0);
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({
        type: asn1_schema_1.AsnPropTypes.Integer,
        context: 1,
        optional: true,
        implicit: true
      })
    ], GeneralSubtree.prototype, "maximum", void 0);
    var GeneralSubtrees = GeneralSubtrees_1 = class GeneralSubtrees extends asn1_schema_1.AsnArray {
      constructor(items) {
        super(items);
        Object.setPrototypeOf(this, GeneralSubtrees_1.prototype);
      }
    };
    exports.GeneralSubtrees = GeneralSubtrees;
    exports.GeneralSubtrees = GeneralSubtrees = GeneralSubtrees_1 = tslib_1.__decorate([
      (0, asn1_schema_1.AsnType)({
        type: asn1_schema_1.AsnTypeTypes.Sequence,
        itemType: GeneralSubtree
      })
    ], GeneralSubtrees);
    var NameConstraints = class {
      permittedSubtrees;
      excludedSubtrees;
      constructor(params = {}) {
        Object.assign(this, params);
      }
    };
    exports.NameConstraints = NameConstraints;
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({
        type: GeneralSubtrees,
        context: 0,
        optional: true,
        implicit: true
      })
    ], NameConstraints.prototype, "permittedSubtrees", void 0);
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({
        type: GeneralSubtrees,
        context: 1,
        optional: true,
        implicit: true
      })
    ], NameConstraints.prototype, "excludedSubtrees", void 0);
  }
});

// node_modules/@peculiar/asn1-x509/build/cjs/extensions/policy_constraints.js
var require_policy_constraints = __commonJS({
  "node_modules/@peculiar/asn1-x509/build/cjs/extensions/policy_constraints.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.PolicyConstraints = exports.id_ce_policyConstraints = void 0;
    var tslib_1 = (init_tslib_es6(), __toCommonJS(tslib_es6_exports));
    var asn1_schema_1 = require_cjs2();
    var object_identifiers_1 = require_object_identifiers();
    exports.id_ce_policyConstraints = `${object_identifiers_1.id_ce}.36`;
    var PolicyConstraints = class {
      requireExplicitPolicy;
      inhibitPolicyMapping;
      constructor(params = {}) {
        Object.assign(this, params);
      }
    };
    exports.PolicyConstraints = PolicyConstraints;
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({
        type: asn1_schema_1.AsnPropTypes.Integer,
        context: 0,
        implicit: true,
        optional: true,
        converter: asn1_schema_1.AsnIntegerArrayBufferConverter
      })
    ], PolicyConstraints.prototype, "requireExplicitPolicy", void 0);
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({
        type: asn1_schema_1.AsnPropTypes.Integer,
        context: 1,
        implicit: true,
        optional: true,
        converter: asn1_schema_1.AsnIntegerArrayBufferConverter
      })
    ], PolicyConstraints.prototype, "inhibitPolicyMapping", void 0);
  }
});

// node_modules/@peculiar/asn1-x509/build/cjs/extensions/policy_mappings.js
var require_policy_mappings = __commonJS({
  "node_modules/@peculiar/asn1-x509/build/cjs/extensions/policy_mappings.js"(exports) {
    "use strict";
    var PolicyMappings_1;
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.PolicyMappings = exports.PolicyMapping = exports.id_ce_policyMappings = void 0;
    var tslib_1 = (init_tslib_es6(), __toCommonJS(tslib_es6_exports));
    var asn1_schema_1 = require_cjs2();
    var object_identifiers_1 = require_object_identifiers();
    exports.id_ce_policyMappings = `${object_identifiers_1.id_ce}.33`;
    var PolicyMapping = class {
      issuerDomainPolicy = "";
      subjectDomainPolicy = "";
      constructor(params = {}) {
        Object.assign(this, params);
      }
    };
    exports.PolicyMapping = PolicyMapping;
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({ type: asn1_schema_1.AsnPropTypes.ObjectIdentifier })
    ], PolicyMapping.prototype, "issuerDomainPolicy", void 0);
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({ type: asn1_schema_1.AsnPropTypes.ObjectIdentifier })
    ], PolicyMapping.prototype, "subjectDomainPolicy", void 0);
    var PolicyMappings = PolicyMappings_1 = class PolicyMappings extends asn1_schema_1.AsnArray {
      constructor(items) {
        super(items);
        Object.setPrototypeOf(this, PolicyMappings_1.prototype);
      }
    };
    exports.PolicyMappings = PolicyMappings;
    exports.PolicyMappings = PolicyMappings = PolicyMappings_1 = tslib_1.__decorate([
      (0, asn1_schema_1.AsnType)({
        type: asn1_schema_1.AsnTypeTypes.Sequence,
        itemType: PolicyMapping
      })
    ], PolicyMappings);
  }
});

// node_modules/@peculiar/asn1-x509/build/cjs/extensions/subject_alternative_name.js
var require_subject_alternative_name = __commonJS({
  "node_modules/@peculiar/asn1-x509/build/cjs/extensions/subject_alternative_name.js"(exports) {
    "use strict";
    var SubjectAlternativeName_1;
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.SubjectAlternativeName = exports.id_ce_subjectAltName = void 0;
    var tslib_1 = (init_tslib_es6(), __toCommonJS(tslib_es6_exports));
    var asn1_schema_1 = require_cjs2();
    var general_names_1 = require_general_names();
    var object_identifiers_1 = require_object_identifiers();
    exports.id_ce_subjectAltName = `${object_identifiers_1.id_ce}.17`;
    var SubjectAlternativeName = SubjectAlternativeName_1 = class SubjectAlternativeName extends general_names_1.GeneralNames {
      constructor(items) {
        super(items);
        Object.setPrototypeOf(this, SubjectAlternativeName_1.prototype);
      }
    };
    exports.SubjectAlternativeName = SubjectAlternativeName;
    exports.SubjectAlternativeName = SubjectAlternativeName = SubjectAlternativeName_1 = tslib_1.__decorate([
      (0, asn1_schema_1.AsnType)({ type: asn1_schema_1.AsnTypeTypes.Sequence })
    ], SubjectAlternativeName);
  }
});

// node_modules/@peculiar/asn1-x509/build/cjs/attribute.js
var require_attribute = __commonJS({
  "node_modules/@peculiar/asn1-x509/build/cjs/attribute.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.Attribute = void 0;
    var tslib_1 = (init_tslib_es6(), __toCommonJS(tslib_es6_exports));
    var asn1_schema_1 = require_cjs2();
    var Attribute = class {
      type = "";
      values = [];
      constructor(params = {}) {
        Object.assign(this, params);
      }
    };
    exports.Attribute = Attribute;
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({ type: asn1_schema_1.AsnPropTypes.ObjectIdentifier })
    ], Attribute.prototype, "type", void 0);
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({
        type: asn1_schema_1.AsnPropTypes.Any,
        repeated: "set"
      })
    ], Attribute.prototype, "values", void 0);
  }
});

// node_modules/@peculiar/asn1-x509/build/cjs/extensions/subject_directory_attributes.js
var require_subject_directory_attributes = __commonJS({
  "node_modules/@peculiar/asn1-x509/build/cjs/extensions/subject_directory_attributes.js"(exports) {
    "use strict";
    var SubjectDirectoryAttributes_1;
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.SubjectDirectoryAttributes = exports.id_ce_subjectDirectoryAttributes = void 0;
    var tslib_1 = (init_tslib_es6(), __toCommonJS(tslib_es6_exports));
    var asn1_schema_1 = require_cjs2();
    var attribute_1 = require_attribute();
    var object_identifiers_1 = require_object_identifiers();
    exports.id_ce_subjectDirectoryAttributes = `${object_identifiers_1.id_ce}.9`;
    var SubjectDirectoryAttributes = SubjectDirectoryAttributes_1 = class SubjectDirectoryAttributes extends asn1_schema_1.AsnArray {
      constructor(items) {
        super(items);
        Object.setPrototypeOf(this, SubjectDirectoryAttributes_1.prototype);
      }
    };
    exports.SubjectDirectoryAttributes = SubjectDirectoryAttributes;
    exports.SubjectDirectoryAttributes = SubjectDirectoryAttributes = SubjectDirectoryAttributes_1 = tslib_1.__decorate([
      (0, asn1_schema_1.AsnType)({
        type: asn1_schema_1.AsnTypeTypes.Sequence,
        itemType: attribute_1.Attribute
      })
    ], SubjectDirectoryAttributes);
  }
});

// node_modules/@peculiar/asn1-x509/build/cjs/extensions/subject_key_identifier.js
var require_subject_key_identifier = __commonJS({
  "node_modules/@peculiar/asn1-x509/build/cjs/extensions/subject_key_identifier.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.SubjectKeyIdentifier = exports.id_ce_subjectKeyIdentifier = void 0;
    var object_identifiers_1 = require_object_identifiers();
    var authority_key_identifier_1 = require_authority_key_identifier();
    exports.id_ce_subjectKeyIdentifier = `${object_identifiers_1.id_ce}.14`;
    var SubjectKeyIdentifier = class extends authority_key_identifier_1.KeyIdentifier {
    };
    exports.SubjectKeyIdentifier = SubjectKeyIdentifier;
  }
});

// node_modules/@peculiar/asn1-x509/build/cjs/extensions/private_key_usage_period.js
var require_private_key_usage_period = __commonJS({
  "node_modules/@peculiar/asn1-x509/build/cjs/extensions/private_key_usage_period.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.PrivateKeyUsagePeriod = exports.id_ce_privateKeyUsagePeriod = void 0;
    var tslib_1 = (init_tslib_es6(), __toCommonJS(tslib_es6_exports));
    var asn1_schema_1 = require_cjs2();
    var object_identifiers_1 = require_object_identifiers();
    exports.id_ce_privateKeyUsagePeriod = `${object_identifiers_1.id_ce}.16`;
    var PrivateKeyUsagePeriod = class {
      notBefore;
      notAfter;
      constructor(params = {}) {
        Object.assign(this, params);
      }
    };
    exports.PrivateKeyUsagePeriod = PrivateKeyUsagePeriod;
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({
        type: asn1_schema_1.AsnPropTypes.GeneralizedTime,
        context: 0,
        implicit: true,
        optional: true
      })
    ], PrivateKeyUsagePeriod.prototype, "notBefore", void 0);
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({
        type: asn1_schema_1.AsnPropTypes.GeneralizedTime,
        context: 1,
        implicit: true,
        optional: true
      })
    ], PrivateKeyUsagePeriod.prototype, "notAfter", void 0);
  }
});

// node_modules/@peculiar/asn1-x509/build/cjs/extensions/entrust_version_info.js
var require_entrust_version_info = __commonJS({
  "node_modules/@peculiar/asn1-x509/build/cjs/extensions/entrust_version_info.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.EntrustVersionInfo = exports.EntrustInfo = exports.EntrustInfoFlags = exports.id_entrust_entrustVersInfo = void 0;
    var tslib_1 = (init_tslib_es6(), __toCommonJS(tslib_es6_exports));
    var asn1_schema_1 = require_cjs2();
    exports.id_entrust_entrustVersInfo = "1.2.840.113533.7.65.0";
    var EntrustInfoFlags;
    (function(EntrustInfoFlags2) {
      EntrustInfoFlags2[EntrustInfoFlags2["keyUpdateAllowed"] = 1] = "keyUpdateAllowed";
      EntrustInfoFlags2[EntrustInfoFlags2["newExtensions"] = 2] = "newExtensions";
      EntrustInfoFlags2[EntrustInfoFlags2["pKIXCertificate"] = 4] = "pKIXCertificate";
    })(EntrustInfoFlags || (exports.EntrustInfoFlags = EntrustInfoFlags = {}));
    var EntrustInfo = class extends asn1_schema_1.BitString {
      toJSON() {
        const res = [];
        const flags = this.toNumber();
        if (flags & EntrustInfoFlags.pKIXCertificate) {
          res.push("pKIXCertificate");
        }
        if (flags & EntrustInfoFlags.newExtensions) {
          res.push("newExtensions");
        }
        if (flags & EntrustInfoFlags.keyUpdateAllowed) {
          res.push("keyUpdateAllowed");
        }
        return res;
      }
      toString() {
        return `[${this.toJSON().join(", ")}]`;
      }
    };
    exports.EntrustInfo = EntrustInfo;
    var EntrustVersionInfo = class {
      entrustVers = "";
      entrustInfoFlags = new EntrustInfo();
      constructor(params = {}) {
        Object.assign(this, params);
      }
    };
    exports.EntrustVersionInfo = EntrustVersionInfo;
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({ type: asn1_schema_1.AsnPropTypes.GeneralString })
    ], EntrustVersionInfo.prototype, "entrustVers", void 0);
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({ type: EntrustInfo })
    ], EntrustVersionInfo.prototype, "entrustInfoFlags", void 0);
  }
});

// node_modules/@peculiar/asn1-x509/build/cjs/extensions/subject_info_access.js
var require_subject_info_access = __commonJS({
  "node_modules/@peculiar/asn1-x509/build/cjs/extensions/subject_info_access.js"(exports) {
    "use strict";
    var SubjectInfoAccessSyntax_1;
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.SubjectInfoAccessSyntax = exports.id_pe_subjectInfoAccess = void 0;
    var tslib_1 = (init_tslib_es6(), __toCommonJS(tslib_es6_exports));
    var asn1_schema_1 = require_cjs2();
    var object_identifiers_1 = require_object_identifiers();
    var authority_information_access_1 = require_authority_information_access();
    exports.id_pe_subjectInfoAccess = `${object_identifiers_1.id_pe}.11`;
    var SubjectInfoAccessSyntax = SubjectInfoAccessSyntax_1 = class SubjectInfoAccessSyntax extends asn1_schema_1.AsnArray {
      constructor(items) {
        super(items);
        Object.setPrototypeOf(this, SubjectInfoAccessSyntax_1.prototype);
      }
    };
    exports.SubjectInfoAccessSyntax = SubjectInfoAccessSyntax;
    exports.SubjectInfoAccessSyntax = SubjectInfoAccessSyntax = SubjectInfoAccessSyntax_1 = tslib_1.__decorate([
      (0, asn1_schema_1.AsnType)({
        type: asn1_schema_1.AsnTypeTypes.Sequence,
        itemType: authority_information_access_1.AccessDescription
      })
    ], SubjectInfoAccessSyntax);
  }
});

// node_modules/@peculiar/asn1-x509/build/cjs/extensions/index.js
var require_extensions = __commonJS({
  "node_modules/@peculiar/asn1-x509/build/cjs/extensions/index.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    var tslib_1 = (init_tslib_es6(), __toCommonJS(tslib_es6_exports));
    tslib_1.__exportStar(require_authority_information_access(), exports);
    tslib_1.__exportStar(require_authority_key_identifier(), exports);
    tslib_1.__exportStar(require_basic_constraints(), exports);
    tslib_1.__exportStar(require_certificate_issuer(), exports);
    tslib_1.__exportStar(require_certificate_policies(), exports);
    tslib_1.__exportStar(require_crl_delta_indicator(), exports);
    tslib_1.__exportStar(require_crl_distribution_points(), exports);
    tslib_1.__exportStar(require_crl_freshest(), exports);
    tslib_1.__exportStar(require_crl_issuing_distribution_point(), exports);
    tslib_1.__exportStar(require_crl_number(), exports);
    tslib_1.__exportStar(require_crl_reason(), exports);
    tslib_1.__exportStar(require_extended_key_usage(), exports);
    tslib_1.__exportStar(require_inhibit_any_policy(), exports);
    tslib_1.__exportStar(require_invalidity_date(), exports);
    tslib_1.__exportStar(require_issuer_alternative_name(), exports);
    tslib_1.__exportStar(require_key_usage(), exports);
    tslib_1.__exportStar(require_name_constraints(), exports);
    tslib_1.__exportStar(require_policy_constraints(), exports);
    tslib_1.__exportStar(require_policy_mappings(), exports);
    tslib_1.__exportStar(require_subject_alternative_name(), exports);
    tslib_1.__exportStar(require_subject_directory_attributes(), exports);
    tslib_1.__exportStar(require_subject_key_identifier(), exports);
    tslib_1.__exportStar(require_private_key_usage_period(), exports);
    tslib_1.__exportStar(require_entrust_version_info(), exports);
    tslib_1.__exportStar(require_subject_info_access(), exports);
  }
});

// node_modules/@peculiar/asn1-x509/build/cjs/algorithm_identifier.js
var require_algorithm_identifier = __commonJS({
  "node_modules/@peculiar/asn1-x509/build/cjs/algorithm_identifier.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.AlgorithmIdentifier = void 0;
    var tslib_1 = (init_tslib_es6(), __toCommonJS(tslib_es6_exports));
    var asn1_schema_1 = require_cjs2();
    var bytes_1 = require_bytes();
    var AlgorithmIdentifier = class _AlgorithmIdentifier {
      algorithm = "";
      parameters;
      constructor(params = {}) {
        Object.assign(this, params);
      }
      isEqual(data) {
        return data instanceof _AlgorithmIdentifier && data.algorithm == this.algorithm && (data.parameters && this.parameters && (0, bytes_1.equal)(data.parameters, this.parameters) || data.parameters === this.parameters);
      }
    };
    exports.AlgorithmIdentifier = AlgorithmIdentifier;
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({ type: asn1_schema_1.AsnPropTypes.ObjectIdentifier })
    ], AlgorithmIdentifier.prototype, "algorithm", void 0);
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({
        type: asn1_schema_1.AsnPropTypes.Any,
        optional: true
      })
    ], AlgorithmIdentifier.prototype, "parameters", void 0);
  }
});

// node_modules/@peculiar/asn1-x509/build/cjs/subject_public_key_info.js
var require_subject_public_key_info = __commonJS({
  "node_modules/@peculiar/asn1-x509/build/cjs/subject_public_key_info.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.SubjectPublicKeyInfo = void 0;
    var tslib_1 = (init_tslib_es6(), __toCommonJS(tslib_es6_exports));
    var asn1_schema_1 = require_cjs2();
    var algorithm_identifier_1 = require_algorithm_identifier();
    var SubjectPublicKeyInfo = class {
      algorithm = new algorithm_identifier_1.AlgorithmIdentifier();
      subjectPublicKey = new ArrayBuffer(0);
      constructor(params = {}) {
        Object.assign(this, params);
      }
    };
    exports.SubjectPublicKeyInfo = SubjectPublicKeyInfo;
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({ type: algorithm_identifier_1.AlgorithmIdentifier })
    ], SubjectPublicKeyInfo.prototype, "algorithm", void 0);
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({ type: asn1_schema_1.AsnPropTypes.BitString })
    ], SubjectPublicKeyInfo.prototype, "subjectPublicKey", void 0);
  }
});

// node_modules/@peculiar/asn1-x509/build/cjs/time.js
var require_time = __commonJS({
  "node_modules/@peculiar/asn1-x509/build/cjs/time.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.Time = void 0;
    var tslib_1 = (init_tslib_es6(), __toCommonJS(tslib_es6_exports));
    var asn1_schema_1 = require_cjs2();
    var Time = class Time {
      utcTime;
      generalTime;
      constructor(time) {
        if (time) {
          if (typeof time === "string" || typeof time === "number" || time instanceof Date) {
            const date = new Date(time);
            date.setMilliseconds(0);
            if (date.getUTCFullYear() > 2049) {
              this.generalTime = date;
            } else {
              this.utcTime = date;
            }
          } else {
            Object.assign(this, time);
          }
        }
      }
      getTime() {
        const time = this.utcTime || this.generalTime;
        if (!time) {
          throw new Error("Cannot get time from CHOICE object");
        }
        return time;
      }
    };
    exports.Time = Time;
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({ type: asn1_schema_1.AsnPropTypes.UTCTime })
    ], Time.prototype, "utcTime", void 0);
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({ type: asn1_schema_1.AsnPropTypes.GeneralizedTime })
    ], Time.prototype, "generalTime", void 0);
    exports.Time = Time = tslib_1.__decorate([
      (0, asn1_schema_1.AsnType)({ type: asn1_schema_1.AsnTypeTypes.Choice })
    ], Time);
  }
});

// node_modules/@peculiar/asn1-x509/build/cjs/validity.js
var require_validity = __commonJS({
  "node_modules/@peculiar/asn1-x509/build/cjs/validity.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.Validity = void 0;
    var tslib_1 = (init_tslib_es6(), __toCommonJS(tslib_es6_exports));
    var asn1_schema_1 = require_cjs2();
    var time_1 = require_time();
    var Validity = class {
      notBefore = new time_1.Time(/* @__PURE__ */ new Date());
      notAfter = new time_1.Time(/* @__PURE__ */ new Date());
      constructor(params) {
        if (params) {
          this.notBefore = new time_1.Time(params.notBefore);
          this.notAfter = new time_1.Time(params.notAfter);
        }
      }
    };
    exports.Validity = Validity;
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({ type: time_1.Time })
    ], Validity.prototype, "notBefore", void 0);
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({ type: time_1.Time })
    ], Validity.prototype, "notAfter", void 0);
  }
});

// node_modules/@peculiar/asn1-x509/build/cjs/extension.js
var require_extension = __commonJS({
  "node_modules/@peculiar/asn1-x509/build/cjs/extension.js"(exports) {
    "use strict";
    var Extensions_1;
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.Extensions = exports.Extension = void 0;
    var tslib_1 = (init_tslib_es6(), __toCommonJS(tslib_es6_exports));
    var asn1_schema_1 = require_cjs2();
    var Extension = class _Extension {
      static CRITICAL = false;
      extnID = "";
      critical = _Extension.CRITICAL;
      extnValue = new asn1_schema_1.OctetString();
      constructor(params = {}) {
        Object.assign(this, params);
      }
    };
    exports.Extension = Extension;
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({ type: asn1_schema_1.AsnPropTypes.ObjectIdentifier })
    ], Extension.prototype, "extnID", void 0);
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({
        type: asn1_schema_1.AsnPropTypes.Boolean,
        defaultValue: Extension.CRITICAL
      })
    ], Extension.prototype, "critical", void 0);
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({ type: asn1_schema_1.OctetString })
    ], Extension.prototype, "extnValue", void 0);
    var Extensions = Extensions_1 = class Extensions extends asn1_schema_1.AsnArray {
      constructor(items) {
        super(items);
        Object.setPrototypeOf(this, Extensions_1.prototype);
      }
    };
    exports.Extensions = Extensions;
    exports.Extensions = Extensions = Extensions_1 = tslib_1.__decorate([
      (0, asn1_schema_1.AsnType)({
        type: asn1_schema_1.AsnTypeTypes.Sequence,
        itemType: Extension
      })
    ], Extensions);
  }
});

// node_modules/@peculiar/asn1-x509/build/cjs/types.js
var require_types2 = __commonJS({
  "node_modules/@peculiar/asn1-x509/build/cjs/types.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.Version = void 0;
    var Version;
    (function(Version2) {
      Version2[Version2["v1"] = 0] = "v1";
      Version2[Version2["v2"] = 1] = "v2";
      Version2[Version2["v3"] = 2] = "v3";
    })(Version || (exports.Version = Version = {}));
  }
});

// node_modules/@peculiar/asn1-x509/build/cjs/tbs_certificate.js
var require_tbs_certificate = __commonJS({
  "node_modules/@peculiar/asn1-x509/build/cjs/tbs_certificate.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.TBSCertificate = void 0;
    var tslib_1 = (init_tslib_es6(), __toCommonJS(tslib_es6_exports));
    var asn1_schema_1 = require_cjs2();
    var algorithm_identifier_1 = require_algorithm_identifier();
    var name_1 = require_name();
    var subject_public_key_info_1 = require_subject_public_key_info();
    var validity_1 = require_validity();
    var extension_1 = require_extension();
    var types_1 = require_types2();
    var TBSCertificate = class {
      version = types_1.Version.v1;
      serialNumber = new ArrayBuffer(0);
      signature = new algorithm_identifier_1.AlgorithmIdentifier();
      issuer = new name_1.Name();
      validity = new validity_1.Validity();
      subject = new name_1.Name();
      subjectPublicKeyInfo = new subject_public_key_info_1.SubjectPublicKeyInfo();
      issuerUniqueID;
      subjectUniqueID;
      extensions;
      constructor(params = {}) {
        Object.assign(this, params);
      }
    };
    exports.TBSCertificate = TBSCertificate;
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({
        type: asn1_schema_1.AsnPropTypes.Integer,
        context: 0,
        defaultValue: types_1.Version.v1
      })
    ], TBSCertificate.prototype, "version", void 0);
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({
        type: asn1_schema_1.AsnPropTypes.Integer,
        converter: asn1_schema_1.AsnIntegerArrayBufferConverter
      })
    ], TBSCertificate.prototype, "serialNumber", void 0);
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({ type: algorithm_identifier_1.AlgorithmIdentifier })
    ], TBSCertificate.prototype, "signature", void 0);
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({ type: name_1.Name })
    ], TBSCertificate.prototype, "issuer", void 0);
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({ type: validity_1.Validity })
    ], TBSCertificate.prototype, "validity", void 0);
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({ type: name_1.Name })
    ], TBSCertificate.prototype, "subject", void 0);
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({ type: subject_public_key_info_1.SubjectPublicKeyInfo })
    ], TBSCertificate.prototype, "subjectPublicKeyInfo", void 0);
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({
        type: asn1_schema_1.AsnPropTypes.BitString,
        context: 1,
        implicit: true,
        optional: true
      })
    ], TBSCertificate.prototype, "issuerUniqueID", void 0);
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({
        type: asn1_schema_1.AsnPropTypes.BitString,
        context: 2,
        implicit: true,
        optional: true
      })
    ], TBSCertificate.prototype, "subjectUniqueID", void 0);
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({
        type: extension_1.Extensions,
        context: 3,
        optional: true
      })
    ], TBSCertificate.prototype, "extensions", void 0);
  }
});

// node_modules/@peculiar/asn1-x509/build/cjs/certificate.js
var require_certificate = __commonJS({
  "node_modules/@peculiar/asn1-x509/build/cjs/certificate.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.Certificate = void 0;
    var tslib_1 = (init_tslib_es6(), __toCommonJS(tslib_es6_exports));
    var asn1_schema_1 = require_cjs2();
    var algorithm_identifier_1 = require_algorithm_identifier();
    var tbs_certificate_1 = require_tbs_certificate();
    var Certificate = class {
      tbsCertificate = new tbs_certificate_1.TBSCertificate();
      tbsCertificateRaw;
      signatureAlgorithm = new algorithm_identifier_1.AlgorithmIdentifier();
      signatureValue = new ArrayBuffer(0);
      constructor(params = {}) {
        Object.assign(this, params);
      }
    };
    exports.Certificate = Certificate;
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({
        type: tbs_certificate_1.TBSCertificate,
        raw: true
      })
    ], Certificate.prototype, "tbsCertificate", void 0);
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({ type: algorithm_identifier_1.AlgorithmIdentifier })
    ], Certificate.prototype, "signatureAlgorithm", void 0);
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({ type: asn1_schema_1.AsnPropTypes.BitString })
    ], Certificate.prototype, "signatureValue", void 0);
  }
});

// node_modules/@peculiar/asn1-x509/build/cjs/tbs_cert_list.js
var require_tbs_cert_list = __commonJS({
  "node_modules/@peculiar/asn1-x509/build/cjs/tbs_cert_list.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.TBSCertList = exports.RevokedCertificate = void 0;
    var tslib_1 = (init_tslib_es6(), __toCommonJS(tslib_es6_exports));
    var asn1_schema_1 = require_cjs2();
    var algorithm_identifier_1 = require_algorithm_identifier();
    var name_1 = require_name();
    var time_1 = require_time();
    var extension_1 = require_extension();
    var RevokedCertificate = class {
      userCertificate = new ArrayBuffer(0);
      revocationDate = new time_1.Time();
      crlEntryExtensions;
      constructor(params = {}) {
        Object.assign(this, params);
      }
    };
    exports.RevokedCertificate = RevokedCertificate;
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({
        type: asn1_schema_1.AsnPropTypes.Integer,
        converter: asn1_schema_1.AsnIntegerArrayBufferConverter
      })
    ], RevokedCertificate.prototype, "userCertificate", void 0);
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({ type: time_1.Time })
    ], RevokedCertificate.prototype, "revocationDate", void 0);
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({
        type: extension_1.Extension,
        optional: true,
        repeated: "sequence"
      })
    ], RevokedCertificate.prototype, "crlEntryExtensions", void 0);
    var TBSCertList = class {
      version;
      signature = new algorithm_identifier_1.AlgorithmIdentifier();
      issuer = new name_1.Name();
      thisUpdate = new time_1.Time();
      nextUpdate;
      revokedCertificates;
      crlExtensions;
      constructor(params = {}) {
        Object.assign(this, params);
      }
    };
    exports.TBSCertList = TBSCertList;
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({
        type: asn1_schema_1.AsnPropTypes.Integer,
        optional: true
      })
    ], TBSCertList.prototype, "version", void 0);
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({ type: algorithm_identifier_1.AlgorithmIdentifier })
    ], TBSCertList.prototype, "signature", void 0);
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({ type: name_1.Name })
    ], TBSCertList.prototype, "issuer", void 0);
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({ type: time_1.Time })
    ], TBSCertList.prototype, "thisUpdate", void 0);
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({
        type: time_1.Time,
        optional: true
      })
    ], TBSCertList.prototype, "nextUpdate", void 0);
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({
        type: RevokedCertificate,
        repeated: "sequence",
        optional: true
      })
    ], TBSCertList.prototype, "revokedCertificates", void 0);
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({
        type: extension_1.Extension,
        optional: true,
        context: 0,
        repeated: "sequence"
      })
    ], TBSCertList.prototype, "crlExtensions", void 0);
  }
});

// node_modules/@peculiar/asn1-x509/build/cjs/certificate_list.js
var require_certificate_list = __commonJS({
  "node_modules/@peculiar/asn1-x509/build/cjs/certificate_list.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.CertificateList = void 0;
    var tslib_1 = (init_tslib_es6(), __toCommonJS(tslib_es6_exports));
    var asn1_schema_1 = require_cjs2();
    var algorithm_identifier_1 = require_algorithm_identifier();
    var tbs_cert_list_1 = require_tbs_cert_list();
    var CertificateList = class {
      tbsCertList = new tbs_cert_list_1.TBSCertList();
      tbsCertListRaw;
      signatureAlgorithm = new algorithm_identifier_1.AlgorithmIdentifier();
      signature = new ArrayBuffer(0);
      constructor(params = {}) {
        Object.assign(this, params);
      }
    };
    exports.CertificateList = CertificateList;
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({
        type: tbs_cert_list_1.TBSCertList,
        raw: true
      })
    ], CertificateList.prototype, "tbsCertList", void 0);
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({ type: algorithm_identifier_1.AlgorithmIdentifier })
    ], CertificateList.prototype, "signatureAlgorithm", void 0);
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({ type: asn1_schema_1.AsnPropTypes.BitString })
    ], CertificateList.prototype, "signature", void 0);
  }
});

// node_modules/@peculiar/asn1-x509/build/cjs/index.js
var require_cjs3 = __commonJS({
  "node_modules/@peculiar/asn1-x509/build/cjs/index.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    var tslib_1 = (init_tslib_es6(), __toCommonJS(tslib_es6_exports));
    tslib_1.__exportStar(require_extensions(), exports);
    tslib_1.__exportStar(require_algorithm_identifier(), exports);
    tslib_1.__exportStar(require_attribute(), exports);
    tslib_1.__exportStar(require_certificate(), exports);
    tslib_1.__exportStar(require_certificate_list(), exports);
    tslib_1.__exportStar(require_extension(), exports);
    tslib_1.__exportStar(require_general_name(), exports);
    tslib_1.__exportStar(require_general_names(), exports);
    tslib_1.__exportStar(require_name(), exports);
    tslib_1.__exportStar(require_object_identifiers(), exports);
    tslib_1.__exportStar(require_subject_public_key_info(), exports);
    tslib_1.__exportStar(require_tbs_cert_list(), exports);
    tslib_1.__exportStar(require_tbs_certificate(), exports);
    tslib_1.__exportStar(require_time(), exports);
    tslib_1.__exportStar(require_types2(), exports);
    tslib_1.__exportStar(require_validity(), exports);
  }
});

// node_modules/@peculiar/asn1-cms/build/cjs/issuer_and_serial_number.js
var require_issuer_and_serial_number = __commonJS({
  "node_modules/@peculiar/asn1-cms/build/cjs/issuer_and_serial_number.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.IssuerAndSerialNumber = void 0;
    var tslib_1 = (init_tslib_es6(), __toCommonJS(tslib_es6_exports));
    var asn1_schema_1 = require_cjs2();
    var asn1_x509_1 = require_cjs3();
    var IssuerAndSerialNumber = class {
      issuer = new asn1_x509_1.Name();
      serialNumber = new ArrayBuffer(0);
      constructor(params = {}) {
        Object.assign(this, params);
      }
    };
    exports.IssuerAndSerialNumber = IssuerAndSerialNumber;
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({ type: asn1_x509_1.Name })
    ], IssuerAndSerialNumber.prototype, "issuer", void 0);
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({
        type: asn1_schema_1.AsnPropTypes.Integer,
        converter: asn1_schema_1.AsnIntegerArrayBufferConverter
      })
    ], IssuerAndSerialNumber.prototype, "serialNumber", void 0);
  }
});

// node_modules/@peculiar/asn1-cms/build/cjs/signer_identifier.js
var require_signer_identifier = __commonJS({
  "node_modules/@peculiar/asn1-cms/build/cjs/signer_identifier.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.SignerIdentifier = void 0;
    var tslib_1 = (init_tslib_es6(), __toCommonJS(tslib_es6_exports));
    var asn1_schema_1 = require_cjs2();
    var asn1_x509_1 = require_cjs3();
    var issuer_and_serial_number_1 = require_issuer_and_serial_number();
    var SignerIdentifier = class SignerIdentifier {
      subjectKeyIdentifier;
      issuerAndSerialNumber;
      constructor(params = {}) {
        Object.assign(this, params);
      }
    };
    exports.SignerIdentifier = SignerIdentifier;
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({
        type: asn1_x509_1.SubjectKeyIdentifier,
        context: 0,
        implicit: true
      })
    ], SignerIdentifier.prototype, "subjectKeyIdentifier", void 0);
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({ type: issuer_and_serial_number_1.IssuerAndSerialNumber })
    ], SignerIdentifier.prototype, "issuerAndSerialNumber", void 0);
    exports.SignerIdentifier = SignerIdentifier = tslib_1.__decorate([
      (0, asn1_schema_1.AsnType)({ type: asn1_schema_1.AsnTypeTypes.Choice })
    ], SignerIdentifier);
  }
});

// node_modules/@peculiar/asn1-cms/build/cjs/types.js
var require_types3 = __commonJS({
  "node_modules/@peculiar/asn1-cms/build/cjs/types.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.KeyDerivationAlgorithmIdentifier = exports.MessageAuthenticationCodeAlgorithm = exports.ContentEncryptionAlgorithmIdentifier = exports.KeyEncryptionAlgorithmIdentifier = exports.SignatureAlgorithmIdentifier = exports.DigestAlgorithmIdentifier = exports.CMSVersion = void 0;
    var tslib_1 = (init_tslib_es6(), __toCommonJS(tslib_es6_exports));
    var asn1_x509_1 = require_cjs3();
    var asn1_schema_1 = require_cjs2();
    var CMSVersion;
    (function(CMSVersion2) {
      CMSVersion2[CMSVersion2["v0"] = 0] = "v0";
      CMSVersion2[CMSVersion2["v1"] = 1] = "v1";
      CMSVersion2[CMSVersion2["v2"] = 2] = "v2";
      CMSVersion2[CMSVersion2["v3"] = 3] = "v3";
      CMSVersion2[CMSVersion2["v4"] = 4] = "v4";
      CMSVersion2[CMSVersion2["v5"] = 5] = "v5";
    })(CMSVersion || (exports.CMSVersion = CMSVersion = {}));
    var DigestAlgorithmIdentifier = class DigestAlgorithmIdentifier extends asn1_x509_1.AlgorithmIdentifier {
    };
    exports.DigestAlgorithmIdentifier = DigestAlgorithmIdentifier;
    exports.DigestAlgorithmIdentifier = DigestAlgorithmIdentifier = tslib_1.__decorate([
      (0, asn1_schema_1.AsnType)({ type: asn1_schema_1.AsnTypeTypes.Sequence })
    ], DigestAlgorithmIdentifier);
    var SignatureAlgorithmIdentifier = class SignatureAlgorithmIdentifier extends asn1_x509_1.AlgorithmIdentifier {
    };
    exports.SignatureAlgorithmIdentifier = SignatureAlgorithmIdentifier;
    exports.SignatureAlgorithmIdentifier = SignatureAlgorithmIdentifier = tslib_1.__decorate([
      (0, asn1_schema_1.AsnType)({ type: asn1_schema_1.AsnTypeTypes.Sequence })
    ], SignatureAlgorithmIdentifier);
    var KeyEncryptionAlgorithmIdentifier = class KeyEncryptionAlgorithmIdentifier extends asn1_x509_1.AlgorithmIdentifier {
    };
    exports.KeyEncryptionAlgorithmIdentifier = KeyEncryptionAlgorithmIdentifier;
    exports.KeyEncryptionAlgorithmIdentifier = KeyEncryptionAlgorithmIdentifier = tslib_1.__decorate([
      (0, asn1_schema_1.AsnType)({ type: asn1_schema_1.AsnTypeTypes.Sequence })
    ], KeyEncryptionAlgorithmIdentifier);
    var ContentEncryptionAlgorithmIdentifier = class ContentEncryptionAlgorithmIdentifier extends asn1_x509_1.AlgorithmIdentifier {
    };
    exports.ContentEncryptionAlgorithmIdentifier = ContentEncryptionAlgorithmIdentifier;
    exports.ContentEncryptionAlgorithmIdentifier = ContentEncryptionAlgorithmIdentifier = tslib_1.__decorate([
      (0, asn1_schema_1.AsnType)({ type: asn1_schema_1.AsnTypeTypes.Sequence })
    ], ContentEncryptionAlgorithmIdentifier);
    var MessageAuthenticationCodeAlgorithm = class MessageAuthenticationCodeAlgorithm extends asn1_x509_1.AlgorithmIdentifier {
    };
    exports.MessageAuthenticationCodeAlgorithm = MessageAuthenticationCodeAlgorithm;
    exports.MessageAuthenticationCodeAlgorithm = MessageAuthenticationCodeAlgorithm = tslib_1.__decorate([
      (0, asn1_schema_1.AsnType)({ type: asn1_schema_1.AsnTypeTypes.Sequence })
    ], MessageAuthenticationCodeAlgorithm);
    var KeyDerivationAlgorithmIdentifier = class KeyDerivationAlgorithmIdentifier extends asn1_x509_1.AlgorithmIdentifier {
    };
    exports.KeyDerivationAlgorithmIdentifier = KeyDerivationAlgorithmIdentifier;
    exports.KeyDerivationAlgorithmIdentifier = KeyDerivationAlgorithmIdentifier = tslib_1.__decorate([
      (0, asn1_schema_1.AsnType)({ type: asn1_schema_1.AsnTypeTypes.Sequence })
    ], KeyDerivationAlgorithmIdentifier);
  }
});

// node_modules/@peculiar/asn1-cms/build/cjs/attribute.js
var require_attribute2 = __commonJS({
  "node_modules/@peculiar/asn1-cms/build/cjs/attribute.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.Attribute = void 0;
    var tslib_1 = (init_tslib_es6(), __toCommonJS(tslib_es6_exports));
    var asn1_schema_1 = require_cjs2();
    var Attribute = class {
      attrType = "";
      attrValues = [];
      constructor(params = {}) {
        Object.assign(this, params);
      }
    };
    exports.Attribute = Attribute;
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({ type: asn1_schema_1.AsnPropTypes.ObjectIdentifier })
    ], Attribute.prototype, "attrType", void 0);
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({
        type: asn1_schema_1.AsnPropTypes.Any,
        repeated: "set"
      })
    ], Attribute.prototype, "attrValues", void 0);
  }
});

// node_modules/@peculiar/asn1-cms/build/cjs/signer_info.js
var require_signer_info = __commonJS({
  "node_modules/@peculiar/asn1-cms/build/cjs/signer_info.js"(exports) {
    "use strict";
    var SignerInfos_1;
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.SignerInfos = exports.SignerInfo = void 0;
    var tslib_1 = (init_tslib_es6(), __toCommonJS(tslib_es6_exports));
    var asn1_schema_1 = require_cjs2();
    var signer_identifier_1 = require_signer_identifier();
    var types_1 = require_types3();
    var attribute_1 = require_attribute2();
    var SignerInfo = class {
      version = types_1.CMSVersion.v0;
      sid = new signer_identifier_1.SignerIdentifier();
      digestAlgorithm = new types_1.DigestAlgorithmIdentifier();
      signedAttrs;
      signedAttrsRaw;
      signatureAlgorithm = new types_1.SignatureAlgorithmIdentifier();
      signature = new asn1_schema_1.OctetString();
      unsignedAttrs;
      constructor(params = {}) {
        Object.assign(this, params);
      }
    };
    exports.SignerInfo = SignerInfo;
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({ type: asn1_schema_1.AsnPropTypes.Integer })
    ], SignerInfo.prototype, "version", void 0);
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({ type: signer_identifier_1.SignerIdentifier })
    ], SignerInfo.prototype, "sid", void 0);
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({ type: types_1.DigestAlgorithmIdentifier })
    ], SignerInfo.prototype, "digestAlgorithm", void 0);
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({
        type: attribute_1.Attribute,
        repeated: "set",
        context: 0,
        implicit: true,
        optional: true,
        raw: true
      })
    ], SignerInfo.prototype, "signedAttrs", void 0);
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({ type: types_1.SignatureAlgorithmIdentifier })
    ], SignerInfo.prototype, "signatureAlgorithm", void 0);
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({ type: asn1_schema_1.OctetString })
    ], SignerInfo.prototype, "signature", void 0);
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({
        type: attribute_1.Attribute,
        repeated: "set",
        context: 1,
        implicit: true,
        optional: true
      })
    ], SignerInfo.prototype, "unsignedAttrs", void 0);
    var SignerInfos = SignerInfos_1 = class SignerInfos extends asn1_schema_1.AsnArray {
      constructor(items) {
        super(items);
        Object.setPrototypeOf(this, SignerInfos_1.prototype);
      }
    };
    exports.SignerInfos = SignerInfos;
    exports.SignerInfos = SignerInfos = SignerInfos_1 = tslib_1.__decorate([
      (0, asn1_schema_1.AsnType)({
        type: asn1_schema_1.AsnTypeTypes.Set,
        itemType: SignerInfo
      })
    ], SignerInfos);
  }
});

// node_modules/@peculiar/asn1-cms/build/cjs/attributes/counter_signature.js
var require_counter_signature = __commonJS({
  "node_modules/@peculiar/asn1-cms/build/cjs/attributes/counter_signature.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.CounterSignature = exports.id_counterSignature = void 0;
    var tslib_1 = (init_tslib_es6(), __toCommonJS(tslib_es6_exports));
    var asn1_schema_1 = require_cjs2();
    var signer_info_1 = require_signer_info();
    exports.id_counterSignature = "1.2.840.113549.1.9.6";
    var CounterSignature = class CounterSignature extends signer_info_1.SignerInfo {
    };
    exports.CounterSignature = CounterSignature;
    exports.CounterSignature = CounterSignature = tslib_1.__decorate([
      (0, asn1_schema_1.AsnType)({ type: asn1_schema_1.AsnTypeTypes.Sequence })
    ], CounterSignature);
  }
});

// node_modules/@peculiar/asn1-cms/build/cjs/attributes/message_digest.js
var require_message_digest = __commonJS({
  "node_modules/@peculiar/asn1-cms/build/cjs/attributes/message_digest.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.MessageDigest = exports.id_messageDigest = void 0;
    var asn1_schema_1 = require_cjs2();
    exports.id_messageDigest = "1.2.840.113549.1.9.4";
    var MessageDigest = class extends asn1_schema_1.OctetString {
    };
    exports.MessageDigest = MessageDigest;
  }
});

// node_modules/@peculiar/asn1-cms/build/cjs/attributes/signing_time.js
var require_signing_time = __commonJS({
  "node_modules/@peculiar/asn1-cms/build/cjs/attributes/signing_time.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.SigningTime = exports.id_signingTime = void 0;
    var tslib_1 = (init_tslib_es6(), __toCommonJS(tslib_es6_exports));
    var asn1_x509_1 = require_cjs3();
    var asn1_schema_1 = require_cjs2();
    exports.id_signingTime = "1.2.840.113549.1.9.5";
    var SigningTime = class SigningTime extends asn1_x509_1.Time {
    };
    exports.SigningTime = SigningTime;
    exports.SigningTime = SigningTime = tslib_1.__decorate([
      (0, asn1_schema_1.AsnType)({ type: asn1_schema_1.AsnTypeTypes.Choice })
    ], SigningTime);
  }
});

// node_modules/@peculiar/asn1-cms/build/cjs/attributes/index.js
var require_attributes = __commonJS({
  "node_modules/@peculiar/asn1-cms/build/cjs/attributes/index.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.id_contentType = void 0;
    var tslib_1 = (init_tslib_es6(), __toCommonJS(tslib_es6_exports));
    tslib_1.__exportStar(require_counter_signature(), exports);
    tslib_1.__exportStar(require_message_digest(), exports);
    tslib_1.__exportStar(require_signing_time(), exports);
    exports.id_contentType = "1.2.840.113549.1.9.3";
  }
});

// node_modules/@peculiar/asn1-x509-attr/build/cjs/aa_clear_attrs.js
var require_aa_clear_attrs = __commonJS({
  "node_modules/@peculiar/asn1-x509-attr/build/cjs/aa_clear_attrs.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.ACClearAttrs = void 0;
    var tslib_1 = (init_tslib_es6(), __toCommonJS(tslib_es6_exports));
    var asn1_schema_1 = require_cjs2();
    var asn1_x509_1 = require_cjs3();
    var ACClearAttrs = class {
      acIssuer = new asn1_x509_1.GeneralName();
      acSerial = 0;
      attrs = [];
      constructor(params = {}) {
        Object.assign(this, params);
      }
    };
    exports.ACClearAttrs = ACClearAttrs;
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({ type: asn1_x509_1.GeneralName })
    ], ACClearAttrs.prototype, "acIssuer", void 0);
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({ type: asn1_schema_1.AsnPropTypes.Integer })
    ], ACClearAttrs.prototype, "acSerial", void 0);
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({
        type: asn1_x509_1.Attribute,
        repeated: "sequence"
      })
    ], ACClearAttrs.prototype, "attrs", void 0);
  }
});

// node_modules/@peculiar/asn1-x509-attr/build/cjs/attr_spec.js
var require_attr_spec = __commonJS({
  "node_modules/@peculiar/asn1-x509-attr/build/cjs/attr_spec.js"(exports) {
    "use strict";
    var AttrSpec_1;
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.AttrSpec = void 0;
    var tslib_1 = (init_tslib_es6(), __toCommonJS(tslib_es6_exports));
    var asn1_schema_1 = require_cjs2();
    var AttrSpec = AttrSpec_1 = class AttrSpec extends asn1_schema_1.AsnArray {
      constructor(items) {
        super(items);
        Object.setPrototypeOf(this, AttrSpec_1.prototype);
      }
    };
    exports.AttrSpec = AttrSpec;
    exports.AttrSpec = AttrSpec = AttrSpec_1 = tslib_1.__decorate([
      (0, asn1_schema_1.AsnType)({
        type: asn1_schema_1.AsnTypeTypes.Sequence,
        itemType: asn1_schema_1.AsnPropTypes.ObjectIdentifier
      })
    ], AttrSpec);
  }
});

// node_modules/@peculiar/asn1-x509-attr/build/cjs/aa_controls.js
var require_aa_controls = __commonJS({
  "node_modules/@peculiar/asn1-x509-attr/build/cjs/aa_controls.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.AAControls = void 0;
    var tslib_1 = (init_tslib_es6(), __toCommonJS(tslib_es6_exports));
    var asn1_schema_1 = require_cjs2();
    var attr_spec_1 = require_attr_spec();
    var AAControls = class {
      pathLenConstraint;
      permittedAttrs;
      excludedAttrs;
      permitUnSpecified = true;
      constructor(params = {}) {
        Object.assign(this, params);
      }
    };
    exports.AAControls = AAControls;
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({
        type: asn1_schema_1.AsnPropTypes.Integer,
        optional: true
      })
    ], AAControls.prototype, "pathLenConstraint", void 0);
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({
        type: attr_spec_1.AttrSpec,
        implicit: true,
        context: 0,
        optional: true
      })
    ], AAControls.prototype, "permittedAttrs", void 0);
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({
        type: attr_spec_1.AttrSpec,
        implicit: true,
        context: 1,
        optional: true
      })
    ], AAControls.prototype, "excludedAttrs", void 0);
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({
        type: asn1_schema_1.AsnPropTypes.Boolean,
        defaultValue: true
      })
    ], AAControls.prototype, "permitUnSpecified", void 0);
  }
});

// node_modules/@peculiar/asn1-x509-attr/build/cjs/issuer_serial.js
var require_issuer_serial = __commonJS({
  "node_modules/@peculiar/asn1-x509-attr/build/cjs/issuer_serial.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.IssuerSerial = void 0;
    var tslib_1 = (init_tslib_es6(), __toCommonJS(tslib_es6_exports));
    var asn1_schema_1 = require_cjs2();
    var asn1_x509_1 = require_cjs3();
    var IssuerSerial = class {
      issuer = new asn1_x509_1.GeneralNames();
      serial = new ArrayBuffer(0);
      issuerUID = new ArrayBuffer(0);
      constructor(params = {}) {
        Object.assign(this, params);
      }
    };
    exports.IssuerSerial = IssuerSerial;
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({ type: asn1_x509_1.GeneralNames })
    ], IssuerSerial.prototype, "issuer", void 0);
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({
        type: asn1_schema_1.AsnPropTypes.Integer,
        converter: asn1_schema_1.AsnIntegerArrayBufferConverter
      })
    ], IssuerSerial.prototype, "serial", void 0);
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({
        type: asn1_schema_1.AsnPropTypes.BitString,
        optional: true
      })
    ], IssuerSerial.prototype, "issuerUID", void 0);
  }
});

// node_modules/@peculiar/asn1-x509-attr/build/cjs/object_digest_info.js
var require_object_digest_info = __commonJS({
  "node_modules/@peculiar/asn1-x509-attr/build/cjs/object_digest_info.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.ObjectDigestInfo = exports.DigestedObjectType = void 0;
    var tslib_1 = (init_tslib_es6(), __toCommonJS(tslib_es6_exports));
    var asn1_schema_1 = require_cjs2();
    var asn1_x509_1 = require_cjs3();
    var DigestedObjectType;
    (function(DigestedObjectType2) {
      DigestedObjectType2[DigestedObjectType2["publicKey"] = 0] = "publicKey";
      DigestedObjectType2[DigestedObjectType2["publicKeyCert"] = 1] = "publicKeyCert";
      DigestedObjectType2[DigestedObjectType2["otherObjectTypes"] = 2] = "otherObjectTypes";
    })(DigestedObjectType || (exports.DigestedObjectType = DigestedObjectType = {}));
    var ObjectDigestInfo = class {
      digestedObjectType = DigestedObjectType.publicKey;
      otherObjectTypeID;
      digestAlgorithm = new asn1_x509_1.AlgorithmIdentifier();
      objectDigest = new ArrayBuffer(0);
      constructor(params = {}) {
        Object.assign(this, params);
      }
    };
    exports.ObjectDigestInfo = ObjectDigestInfo;
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({ type: asn1_schema_1.AsnPropTypes.Enumerated })
    ], ObjectDigestInfo.prototype, "digestedObjectType", void 0);
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({
        type: asn1_schema_1.AsnPropTypes.ObjectIdentifier,
        optional: true
      })
    ], ObjectDigestInfo.prototype, "otherObjectTypeID", void 0);
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({ type: asn1_x509_1.AlgorithmIdentifier })
    ], ObjectDigestInfo.prototype, "digestAlgorithm", void 0);
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({ type: asn1_schema_1.AsnPropTypes.BitString })
    ], ObjectDigestInfo.prototype, "objectDigest", void 0);
  }
});

// node_modules/@peculiar/asn1-x509-attr/build/cjs/v2_form.js
var require_v2_form = __commonJS({
  "node_modules/@peculiar/asn1-x509-attr/build/cjs/v2_form.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.V2Form = void 0;
    var tslib_1 = (init_tslib_es6(), __toCommonJS(tslib_es6_exports));
    var asn1_schema_1 = require_cjs2();
    var asn1_x509_1 = require_cjs3();
    var issuer_serial_1 = require_issuer_serial();
    var object_digest_info_1 = require_object_digest_info();
    var V2Form = class {
      issuerName;
      baseCertificateID;
      objectDigestInfo;
      constructor(params = {}) {
        Object.assign(this, params);
      }
    };
    exports.V2Form = V2Form;
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({
        type: asn1_x509_1.GeneralNames,
        optional: true
      })
    ], V2Form.prototype, "issuerName", void 0);
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({
        type: issuer_serial_1.IssuerSerial,
        context: 0,
        implicit: true,
        optional: true
      })
    ], V2Form.prototype, "baseCertificateID", void 0);
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({
        type: object_digest_info_1.ObjectDigestInfo,
        context: 1,
        implicit: true,
        optional: true
      })
    ], V2Form.prototype, "objectDigestInfo", void 0);
  }
});

// node_modules/@peculiar/asn1-x509-attr/build/cjs/attr_cert_issuer.js
var require_attr_cert_issuer = __commonJS({
  "node_modules/@peculiar/asn1-x509-attr/build/cjs/attr_cert_issuer.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.AttCertIssuer = void 0;
    var tslib_1 = (init_tslib_es6(), __toCommonJS(tslib_es6_exports));
    var asn1_schema_1 = require_cjs2();
    var asn1_x509_1 = require_cjs3();
    var v2_form_1 = require_v2_form();
    var AttCertIssuer = class AttCertIssuer {
      v1Form;
      v2Form;
      constructor(params = {}) {
        Object.assign(this, params);
      }
    };
    exports.AttCertIssuer = AttCertIssuer;
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({
        type: asn1_x509_1.GeneralName,
        repeated: "sequence"
      })
    ], AttCertIssuer.prototype, "v1Form", void 0);
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({
        type: v2_form_1.V2Form,
        context: 0,
        implicit: true
      })
    ], AttCertIssuer.prototype, "v2Form", void 0);
    exports.AttCertIssuer = AttCertIssuer = tslib_1.__decorate([
      (0, asn1_schema_1.AsnType)({ type: asn1_schema_1.AsnTypeTypes.Choice })
    ], AttCertIssuer);
  }
});

// node_modules/@peculiar/asn1-x509-attr/build/cjs/attr_cert_validity_period.js
var require_attr_cert_validity_period = __commonJS({
  "node_modules/@peculiar/asn1-x509-attr/build/cjs/attr_cert_validity_period.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.AttCertValidityPeriod = void 0;
    var tslib_1 = (init_tslib_es6(), __toCommonJS(tslib_es6_exports));
    var asn1_schema_1 = require_cjs2();
    var AttCertValidityPeriod = class {
      notBeforeTime = /* @__PURE__ */ new Date();
      notAfterTime = /* @__PURE__ */ new Date();
      constructor(params = {}) {
        Object.assign(this, params);
      }
    };
    exports.AttCertValidityPeriod = AttCertValidityPeriod;
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({ type: asn1_schema_1.AsnPropTypes.GeneralizedTime })
    ], AttCertValidityPeriod.prototype, "notBeforeTime", void 0);
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({ type: asn1_schema_1.AsnPropTypes.GeneralizedTime })
    ], AttCertValidityPeriod.prototype, "notAfterTime", void 0);
  }
});

// node_modules/@peculiar/asn1-x509-attr/build/cjs/holder.js
var require_holder = __commonJS({
  "node_modules/@peculiar/asn1-x509-attr/build/cjs/holder.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.Holder = void 0;
    var tslib_1 = (init_tslib_es6(), __toCommonJS(tslib_es6_exports));
    var asn1_schema_1 = require_cjs2();
    var asn1_x509_1 = require_cjs3();
    var issuer_serial_1 = require_issuer_serial();
    var object_digest_info_1 = require_object_digest_info();
    var Holder = class {
      baseCertificateID;
      entityName;
      objectDigestInfo;
      constructor(params = {}) {
        Object.assign(this, params);
      }
    };
    exports.Holder = Holder;
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({
        type: issuer_serial_1.IssuerSerial,
        implicit: true,
        context: 0,
        optional: true
      })
    ], Holder.prototype, "baseCertificateID", void 0);
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({
        type: asn1_x509_1.GeneralNames,
        implicit: true,
        context: 1,
        optional: true
      })
    ], Holder.prototype, "entityName", void 0);
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({
        type: object_digest_info_1.ObjectDigestInfo,
        implicit: true,
        context: 2,
        optional: true
      })
    ], Holder.prototype, "objectDigestInfo", void 0);
  }
});

// node_modules/@peculiar/asn1-x509-attr/build/cjs/attribute_certificate_info.js
var require_attribute_certificate_info = __commonJS({
  "node_modules/@peculiar/asn1-x509-attr/build/cjs/attribute_certificate_info.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.AttributeCertificateInfo = exports.AttCertVersion = void 0;
    var tslib_1 = (init_tslib_es6(), __toCommonJS(tslib_es6_exports));
    var asn1_schema_1 = require_cjs2();
    var asn1_x509_1 = require_cjs3();
    var holder_1 = require_holder();
    var attr_cert_issuer_1 = require_attr_cert_issuer();
    var attr_cert_validity_period_1 = require_attr_cert_validity_period();
    var AttCertVersion;
    (function(AttCertVersion2) {
      AttCertVersion2[AttCertVersion2["v2"] = 1] = "v2";
    })(AttCertVersion || (exports.AttCertVersion = AttCertVersion = {}));
    var AttributeCertificateInfo = class {
      version = AttCertVersion.v2;
      holder = new holder_1.Holder();
      issuer = new attr_cert_issuer_1.AttCertIssuer();
      signature = new asn1_x509_1.AlgorithmIdentifier();
      serialNumber = new ArrayBuffer(0);
      attrCertValidityPeriod = new attr_cert_validity_period_1.AttCertValidityPeriod();
      attributes = [];
      issuerUniqueID;
      extensions;
      constructor(params = {}) {
        Object.assign(this, params);
      }
    };
    exports.AttributeCertificateInfo = AttributeCertificateInfo;
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({ type: asn1_schema_1.AsnPropTypes.Integer })
    ], AttributeCertificateInfo.prototype, "version", void 0);
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({ type: holder_1.Holder })
    ], AttributeCertificateInfo.prototype, "holder", void 0);
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({ type: attr_cert_issuer_1.AttCertIssuer })
    ], AttributeCertificateInfo.prototype, "issuer", void 0);
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({ type: asn1_x509_1.AlgorithmIdentifier })
    ], AttributeCertificateInfo.prototype, "signature", void 0);
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({
        type: asn1_schema_1.AsnPropTypes.Integer,
        converter: asn1_schema_1.AsnIntegerArrayBufferConverter
      })
    ], AttributeCertificateInfo.prototype, "serialNumber", void 0);
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({ type: attr_cert_validity_period_1.AttCertValidityPeriod })
    ], AttributeCertificateInfo.prototype, "attrCertValidityPeriod", void 0);
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({
        type: asn1_x509_1.Attribute,
        repeated: "sequence"
      })
    ], AttributeCertificateInfo.prototype, "attributes", void 0);
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({
        type: asn1_schema_1.AsnPropTypes.BitString,
        optional: true
      })
    ], AttributeCertificateInfo.prototype, "issuerUniqueID", void 0);
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({
        type: asn1_x509_1.Extensions,
        optional: true
      })
    ], AttributeCertificateInfo.prototype, "extensions", void 0);
  }
});

// node_modules/@peculiar/asn1-x509-attr/build/cjs/attribute_certificate.js
var require_attribute_certificate = __commonJS({
  "node_modules/@peculiar/asn1-x509-attr/build/cjs/attribute_certificate.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.AttributeCertificate = void 0;
    var tslib_1 = (init_tslib_es6(), __toCommonJS(tslib_es6_exports));
    var asn1_schema_1 = require_cjs2();
    var asn1_x509_1 = require_cjs3();
    var attribute_certificate_info_1 = require_attribute_certificate_info();
    var AttributeCertificate = class {
      acinfo = new attribute_certificate_info_1.AttributeCertificateInfo();
      signatureAlgorithm = new asn1_x509_1.AlgorithmIdentifier();
      signatureValue = new ArrayBuffer(0);
      constructor(params = {}) {
        Object.assign(this, params);
      }
    };
    exports.AttributeCertificate = AttributeCertificate;
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({ type: attribute_certificate_info_1.AttributeCertificateInfo })
    ], AttributeCertificate.prototype, "acinfo", void 0);
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({ type: asn1_x509_1.AlgorithmIdentifier })
    ], AttributeCertificate.prototype, "signatureAlgorithm", void 0);
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({ type: asn1_schema_1.AsnPropTypes.BitString })
    ], AttributeCertificate.prototype, "signatureValue", void 0);
  }
});

// node_modules/@peculiar/asn1-x509-attr/build/cjs/class_list.js
var require_class_list = __commonJS({
  "node_modules/@peculiar/asn1-x509-attr/build/cjs/class_list.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.ClassList = exports.ClassListFlags = void 0;
    var asn1_schema_1 = require_cjs2();
    var ClassListFlags;
    (function(ClassListFlags2) {
      ClassListFlags2[ClassListFlags2["unmarked"] = 1] = "unmarked";
      ClassListFlags2[ClassListFlags2["unclassified"] = 2] = "unclassified";
      ClassListFlags2[ClassListFlags2["restricted"] = 4] = "restricted";
      ClassListFlags2[ClassListFlags2["confidential"] = 8] = "confidential";
      ClassListFlags2[ClassListFlags2["secret"] = 16] = "secret";
      ClassListFlags2[ClassListFlags2["topSecret"] = 32] = "topSecret";
    })(ClassListFlags || (exports.ClassListFlags = ClassListFlags = {}));
    var ClassList = class extends asn1_schema_1.BitString {
    };
    exports.ClassList = ClassList;
  }
});

// node_modules/@peculiar/asn1-x509-attr/build/cjs/security_category.js
var require_security_category = __commonJS({
  "node_modules/@peculiar/asn1-x509-attr/build/cjs/security_category.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.SecurityCategory = void 0;
    var tslib_1 = (init_tslib_es6(), __toCommonJS(tslib_es6_exports));
    var asn1_schema_1 = require_cjs2();
    var SecurityCategory = class {
      type = "";
      value = new ArrayBuffer(0);
      constructor(params = {}) {
        Object.assign(this, params);
      }
    };
    exports.SecurityCategory = SecurityCategory;
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({
        type: asn1_schema_1.AsnPropTypes.ObjectIdentifier,
        implicit: true,
        context: 0
      })
    ], SecurityCategory.prototype, "type", void 0);
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({
        type: asn1_schema_1.AsnPropTypes.Any,
        implicit: true,
        context: 1
      })
    ], SecurityCategory.prototype, "value", void 0);
  }
});

// node_modules/@peculiar/asn1-x509-attr/build/cjs/clearance.js
var require_clearance = __commonJS({
  "node_modules/@peculiar/asn1-x509-attr/build/cjs/clearance.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.Clearance = void 0;
    var tslib_1 = (init_tslib_es6(), __toCommonJS(tslib_es6_exports));
    var asn1_schema_1 = require_cjs2();
    var class_list_1 = require_class_list();
    var security_category_1 = require_security_category();
    var Clearance = class {
      policyId = "";
      classList = new class_list_1.ClassList(class_list_1.ClassListFlags.unclassified);
      securityCategories;
      constructor(params = {}) {
        Object.assign(this, params);
      }
    };
    exports.Clearance = Clearance;
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({ type: asn1_schema_1.AsnPropTypes.ObjectIdentifier })
    ], Clearance.prototype, "policyId", void 0);
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({
        type: class_list_1.ClassList,
        defaultValue: new class_list_1.ClassList(class_list_1.ClassListFlags.unclassified)
      })
    ], Clearance.prototype, "classList", void 0);
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({
        type: security_category_1.SecurityCategory,
        repeated: "set"
      })
    ], Clearance.prototype, "securityCategories", void 0);
  }
});

// node_modules/@peculiar/asn1-x509-attr/build/cjs/ietf_attr_syntax.js
var require_ietf_attr_syntax = __commonJS({
  "node_modules/@peculiar/asn1-x509-attr/build/cjs/ietf_attr_syntax.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.IetfAttrSyntax = exports.IetfAttrSyntaxValueChoices = void 0;
    var tslib_1 = (init_tslib_es6(), __toCommonJS(tslib_es6_exports));
    var asn1_schema_1 = require_cjs2();
    var asn1_x509_1 = require_cjs3();
    var IetfAttrSyntaxValueChoices = class {
      cotets;
      oid;
      string;
      constructor(params = {}) {
        Object.assign(this, params);
      }
    };
    exports.IetfAttrSyntaxValueChoices = IetfAttrSyntaxValueChoices;
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({ type: asn1_schema_1.OctetString })
    ], IetfAttrSyntaxValueChoices.prototype, "cotets", void 0);
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({ type: asn1_schema_1.AsnPropTypes.ObjectIdentifier })
    ], IetfAttrSyntaxValueChoices.prototype, "oid", void 0);
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({ type: asn1_schema_1.AsnPropTypes.Utf8String })
    ], IetfAttrSyntaxValueChoices.prototype, "string", void 0);
    var IetfAttrSyntax = class {
      policyAuthority;
      values = [];
      constructor(params = {}) {
        Object.assign(this, params);
      }
    };
    exports.IetfAttrSyntax = IetfAttrSyntax;
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({
        type: asn1_x509_1.GeneralNames,
        implicit: true,
        context: 0,
        optional: true
      })
    ], IetfAttrSyntax.prototype, "policyAuthority", void 0);
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({
        type: IetfAttrSyntaxValueChoices,
        repeated: "sequence"
      })
    ], IetfAttrSyntax.prototype, "values", void 0);
  }
});

// node_modules/@peculiar/asn1-x509-attr/build/cjs/object_identifiers.js
var require_object_identifiers2 = __commonJS({
  "node_modules/@peculiar/asn1-x509-attr/build/cjs/object_identifiers.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.id_at_clearance = exports.id_at_role = exports.id_at = exports.id_aca_encAttrs = exports.id_aca_group = exports.id_aca_chargingIdentity = exports.id_aca_accessIdentity = exports.id_aca_authenticationInfo = exports.id_aca = exports.id_ce_targetInformation = exports.id_pe_ac_proxying = exports.id_pe_aaControls = exports.id_pe_ac_auditIdentity = void 0;
    var asn1_x509_1 = require_cjs3();
    exports.id_pe_ac_auditIdentity = `${asn1_x509_1.id_pe}.4`;
    exports.id_pe_aaControls = `${asn1_x509_1.id_pe}.6`;
    exports.id_pe_ac_proxying = `${asn1_x509_1.id_pe}.10`;
    exports.id_ce_targetInformation = `${asn1_x509_1.id_ce}.55`;
    exports.id_aca = `${asn1_x509_1.id_pkix}.10`;
    exports.id_aca_authenticationInfo = `${exports.id_aca}.1`;
    exports.id_aca_accessIdentity = `${exports.id_aca}.2`;
    exports.id_aca_chargingIdentity = `${exports.id_aca}.3`;
    exports.id_aca_group = `${exports.id_aca}.4`;
    exports.id_aca_encAttrs = `${exports.id_aca}.6`;
    exports.id_at = "2.5.4";
    exports.id_at_role = `${exports.id_at}.72`;
    exports.id_at_clearance = "2.5.1.5.55";
  }
});

// node_modules/@peculiar/asn1-x509-attr/build/cjs/target.js
var require_target = __commonJS({
  "node_modules/@peculiar/asn1-x509-attr/build/cjs/target.js"(exports) {
    "use strict";
    var Targets_1;
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.Targets = exports.Target = exports.TargetCert = void 0;
    var tslib_1 = (init_tslib_es6(), __toCommonJS(tslib_es6_exports));
    var asn1_schema_1 = require_cjs2();
    var asn1_x509_1 = require_cjs3();
    var issuer_serial_1 = require_issuer_serial();
    var object_digest_info_1 = require_object_digest_info();
    var TargetCert = class {
      targetCertificate = new issuer_serial_1.IssuerSerial();
      targetName;
      certDigestInfo;
      constructor(params = {}) {
        Object.assign(this, params);
      }
    };
    exports.TargetCert = TargetCert;
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({ type: issuer_serial_1.IssuerSerial })
    ], TargetCert.prototype, "targetCertificate", void 0);
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({
        type: asn1_x509_1.GeneralName,
        optional: true
      })
    ], TargetCert.prototype, "targetName", void 0);
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({
        type: object_digest_info_1.ObjectDigestInfo,
        optional: true
      })
    ], TargetCert.prototype, "certDigestInfo", void 0);
    var Target = class Target {
      targetName;
      targetGroup;
      targetCert;
      constructor(params = {}) {
        Object.assign(this, params);
      }
    };
    exports.Target = Target;
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({
        type: asn1_x509_1.GeneralName,
        context: 0,
        implicit: true
      })
    ], Target.prototype, "targetName", void 0);
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({
        type: asn1_x509_1.GeneralName,
        context: 1,
        implicit: true
      })
    ], Target.prototype, "targetGroup", void 0);
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({
        type: TargetCert,
        context: 2,
        implicit: true
      })
    ], Target.prototype, "targetCert", void 0);
    exports.Target = Target = tslib_1.__decorate([
      (0, asn1_schema_1.AsnType)({ type: asn1_schema_1.AsnTypeTypes.Choice })
    ], Target);
    var Targets = Targets_1 = class Targets extends asn1_schema_1.AsnArray {
      constructor(items) {
        super(items);
        Object.setPrototypeOf(this, Targets_1.prototype);
      }
    };
    exports.Targets = Targets;
    exports.Targets = Targets = Targets_1 = tslib_1.__decorate([
      (0, asn1_schema_1.AsnType)({
        type: asn1_schema_1.AsnTypeTypes.Sequence,
        itemType: Target
      })
    ], Targets);
  }
});

// node_modules/@peculiar/asn1-x509-attr/build/cjs/proxy_info.js
var require_proxy_info = __commonJS({
  "node_modules/@peculiar/asn1-x509-attr/build/cjs/proxy_info.js"(exports) {
    "use strict";
    var ProxyInfo_1;
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.ProxyInfo = void 0;
    var tslib_1 = (init_tslib_es6(), __toCommonJS(tslib_es6_exports));
    var asn1_schema_1 = require_cjs2();
    var target_1 = require_target();
    var ProxyInfo = ProxyInfo_1 = class ProxyInfo extends asn1_schema_1.AsnArray {
      constructor(items) {
        super(items);
        Object.setPrototypeOf(this, ProxyInfo_1.prototype);
      }
    };
    exports.ProxyInfo = ProxyInfo;
    exports.ProxyInfo = ProxyInfo = ProxyInfo_1 = tslib_1.__decorate([
      (0, asn1_schema_1.AsnType)({
        type: asn1_schema_1.AsnTypeTypes.Sequence,
        itemType: target_1.Targets
      })
    ], ProxyInfo);
  }
});

// node_modules/@peculiar/asn1-x509-attr/build/cjs/role_syntax.js
var require_role_syntax = __commonJS({
  "node_modules/@peculiar/asn1-x509-attr/build/cjs/role_syntax.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.RoleSyntax = void 0;
    var tslib_1 = (init_tslib_es6(), __toCommonJS(tslib_es6_exports));
    var asn1_schema_1 = require_cjs2();
    var asn1_x509_1 = require_cjs3();
    var RoleSyntax = class {
      roleAuthority;
      roleName;
      constructor(params = {}) {
        Object.assign(this, params);
      }
    };
    exports.RoleSyntax = RoleSyntax;
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({
        type: asn1_x509_1.GeneralNames,
        implicit: true,
        context: 0,
        optional: true
      })
    ], RoleSyntax.prototype, "roleAuthority", void 0);
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({
        type: asn1_x509_1.GeneralName,
        implicit: true,
        context: 1
      })
    ], RoleSyntax.prototype, "roleName", void 0);
  }
});

// node_modules/@peculiar/asn1-x509-attr/build/cjs/svce_auth_info.js
var require_svce_auth_info = __commonJS({
  "node_modules/@peculiar/asn1-x509-attr/build/cjs/svce_auth_info.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.SvceAuthInfo = void 0;
    var tslib_1 = (init_tslib_es6(), __toCommonJS(tslib_es6_exports));
    var asn1_schema_1 = require_cjs2();
    var asn1_x509_1 = require_cjs3();
    var SvceAuthInfo = class {
      service = new asn1_x509_1.GeneralName();
      ident = new asn1_x509_1.GeneralName();
      authInfo;
      constructor(params = {}) {
        Object.assign(this, params);
      }
    };
    exports.SvceAuthInfo = SvceAuthInfo;
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({ type: asn1_x509_1.GeneralName })
    ], SvceAuthInfo.prototype, "service", void 0);
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({ type: asn1_x509_1.GeneralName })
    ], SvceAuthInfo.prototype, "ident", void 0);
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({
        type: asn1_schema_1.OctetString,
        optional: true
      })
    ], SvceAuthInfo.prototype, "authInfo", void 0);
  }
});

// node_modules/@peculiar/asn1-x509-attr/build/cjs/index.js
var require_cjs4 = __commonJS({
  "node_modules/@peculiar/asn1-x509-attr/build/cjs/index.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    var tslib_1 = (init_tslib_es6(), __toCommonJS(tslib_es6_exports));
    tslib_1.__exportStar(require_aa_clear_attrs(), exports);
    tslib_1.__exportStar(require_aa_controls(), exports);
    tslib_1.__exportStar(require_attr_cert_issuer(), exports);
    tslib_1.__exportStar(require_attr_cert_validity_period(), exports);
    tslib_1.__exportStar(require_attr_spec(), exports);
    tslib_1.__exportStar(require_attribute_certificate(), exports);
    tslib_1.__exportStar(require_attribute_certificate_info(), exports);
    tslib_1.__exportStar(require_class_list(), exports);
    tslib_1.__exportStar(require_clearance(), exports);
    tslib_1.__exportStar(require_holder(), exports);
    tslib_1.__exportStar(require_ietf_attr_syntax(), exports);
    tslib_1.__exportStar(require_issuer_serial(), exports);
    tslib_1.__exportStar(require_object_digest_info(), exports);
    tslib_1.__exportStar(require_object_identifiers2(), exports);
    tslib_1.__exportStar(require_proxy_info(), exports);
    tslib_1.__exportStar(require_role_syntax(), exports);
    tslib_1.__exportStar(require_security_category(), exports);
    tslib_1.__exportStar(require_svce_auth_info(), exports);
    tslib_1.__exportStar(require_target(), exports);
    tslib_1.__exportStar(require_v2_form(), exports);
  }
});

// node_modules/@peculiar/asn1-cms/build/cjs/certificate_choices.js
var require_certificate_choices = __commonJS({
  "node_modules/@peculiar/asn1-cms/build/cjs/certificate_choices.js"(exports) {
    "use strict";
    var CertificateSet_1;
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.CertificateSet = exports.CertificateChoices = exports.OtherCertificateFormat = void 0;
    var tslib_1 = (init_tslib_es6(), __toCommonJS(tslib_es6_exports));
    var asn1_schema_1 = require_cjs2();
    var asn1_x509_1 = require_cjs3();
    var asn1_x509_attr_1 = require_cjs4();
    var OtherCertificateFormat = class {
      otherCertFormat = "";
      otherCert = new ArrayBuffer(0);
      constructor(params = {}) {
        Object.assign(this, params);
      }
    };
    exports.OtherCertificateFormat = OtherCertificateFormat;
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({ type: asn1_schema_1.AsnPropTypes.ObjectIdentifier })
    ], OtherCertificateFormat.prototype, "otherCertFormat", void 0);
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({ type: asn1_schema_1.AsnPropTypes.Any })
    ], OtherCertificateFormat.prototype, "otherCert", void 0);
    var CertificateChoices = class CertificateChoices {
      certificate;
      v2AttrCert;
      other;
      constructor(params = {}) {
        Object.assign(this, params);
      }
    };
    exports.CertificateChoices = CertificateChoices;
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({ type: asn1_x509_1.Certificate })
    ], CertificateChoices.prototype, "certificate", void 0);
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({
        type: asn1_x509_attr_1.AttributeCertificate,
        context: 2,
        implicit: true
      })
    ], CertificateChoices.prototype, "v2AttrCert", void 0);
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({
        type: OtherCertificateFormat,
        context: 3,
        implicit: true
      })
    ], CertificateChoices.prototype, "other", void 0);
    exports.CertificateChoices = CertificateChoices = tslib_1.__decorate([
      (0, asn1_schema_1.AsnType)({ type: asn1_schema_1.AsnTypeTypes.Choice })
    ], CertificateChoices);
    var CertificateSet = CertificateSet_1 = class CertificateSet extends asn1_schema_1.AsnArray {
      constructor(items) {
        super(items);
        Object.setPrototypeOf(this, CertificateSet_1.prototype);
      }
    };
    exports.CertificateSet = CertificateSet;
    exports.CertificateSet = CertificateSet = CertificateSet_1 = tslib_1.__decorate([
      (0, asn1_schema_1.AsnType)({
        type: asn1_schema_1.AsnTypeTypes.Set,
        itemType: CertificateChoices
      })
    ], CertificateSet);
  }
});

// node_modules/@peculiar/asn1-cms/build/cjs/content_info.js
var require_content_info = __commonJS({
  "node_modules/@peculiar/asn1-cms/build/cjs/content_info.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.ContentInfo = void 0;
    var tslib_1 = (init_tslib_es6(), __toCommonJS(tslib_es6_exports));
    var asn1_schema_1 = require_cjs2();
    var ContentInfo = class {
      contentType = "";
      content = new ArrayBuffer(0);
      constructor(params = {}) {
        Object.assign(this, params);
      }
    };
    exports.ContentInfo = ContentInfo;
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({ type: asn1_schema_1.AsnPropTypes.ObjectIdentifier })
    ], ContentInfo.prototype, "contentType", void 0);
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({
        type: asn1_schema_1.AsnPropTypes.Any,
        context: 0
      })
    ], ContentInfo.prototype, "content", void 0);
  }
});

// node_modules/@peculiar/asn1-cms/build/cjs/encapsulated_content_info.js
var require_encapsulated_content_info = __commonJS({
  "node_modules/@peculiar/asn1-cms/build/cjs/encapsulated_content_info.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.EncapsulatedContentInfo = exports.EncapsulatedContent = void 0;
    var tslib_1 = (init_tslib_es6(), __toCommonJS(tslib_es6_exports));
    var asn1_schema_1 = require_cjs2();
    var EncapsulatedContent = class EncapsulatedContent {
      single;
      any;
      constructor(params = {}) {
        Object.assign(this, params);
      }
    };
    exports.EncapsulatedContent = EncapsulatedContent;
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({ type: asn1_schema_1.OctetString })
    ], EncapsulatedContent.prototype, "single", void 0);
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({ type: asn1_schema_1.AsnPropTypes.Any })
    ], EncapsulatedContent.prototype, "any", void 0);
    exports.EncapsulatedContent = EncapsulatedContent = tslib_1.__decorate([
      (0, asn1_schema_1.AsnType)({ type: asn1_schema_1.AsnTypeTypes.Choice })
    ], EncapsulatedContent);
    var EncapsulatedContentInfo = class {
      eContentType = "";
      eContent;
      constructor(params = {}) {
        Object.assign(this, params);
      }
    };
    exports.EncapsulatedContentInfo = EncapsulatedContentInfo;
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({ type: asn1_schema_1.AsnPropTypes.ObjectIdentifier })
    ], EncapsulatedContentInfo.prototype, "eContentType", void 0);
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({
        type: EncapsulatedContent,
        context: 0,
        optional: true
      })
    ], EncapsulatedContentInfo.prototype, "eContent", void 0);
  }
});

// node_modules/@peculiar/asn1-cms/build/cjs/encrypted_content_info.js
var require_encrypted_content_info = __commonJS({
  "node_modules/@peculiar/asn1-cms/build/cjs/encrypted_content_info.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.EncryptedContentInfo = exports.EncryptedContent = void 0;
    var tslib_1 = (init_tslib_es6(), __toCommonJS(tslib_es6_exports));
    var asn1_schema_1 = require_cjs2();
    var types_1 = require_types3();
    var EncryptedContent = class EncryptedContent {
      value;
      constructedValue;
      constructor(params = {}) {
        Object.assign(this, params);
      }
    };
    exports.EncryptedContent = EncryptedContent;
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({
        type: asn1_schema_1.OctetString,
        context: 0,
        implicit: true,
        optional: true
      })
    ], EncryptedContent.prototype, "value", void 0);
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({
        type: asn1_schema_1.OctetString,
        converter: asn1_schema_1.AsnConstructedOctetStringConverter,
        context: 0,
        implicit: true,
        optional: true,
        repeated: "sequence"
      })
    ], EncryptedContent.prototype, "constructedValue", void 0);
    exports.EncryptedContent = EncryptedContent = tslib_1.__decorate([
      (0, asn1_schema_1.AsnType)({ type: asn1_schema_1.AsnTypeTypes.Choice })
    ], EncryptedContent);
    var EncryptedContentInfo = class {
      contentType = "";
      contentEncryptionAlgorithm = new types_1.ContentEncryptionAlgorithmIdentifier();
      encryptedContent;
      constructor(params = {}) {
        Object.assign(this, params);
      }
    };
    exports.EncryptedContentInfo = EncryptedContentInfo;
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({ type: asn1_schema_1.AsnPropTypes.ObjectIdentifier })
    ], EncryptedContentInfo.prototype, "contentType", void 0);
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({ type: types_1.ContentEncryptionAlgorithmIdentifier })
    ], EncryptedContentInfo.prototype, "contentEncryptionAlgorithm", void 0);
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({
        type: EncryptedContent,
        optional: true
      })
    ], EncryptedContentInfo.prototype, "encryptedContent", void 0);
  }
});

// node_modules/@peculiar/asn1-cms/build/cjs/other_key_attribute.js
var require_other_key_attribute = __commonJS({
  "node_modules/@peculiar/asn1-cms/build/cjs/other_key_attribute.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.OtherKeyAttribute = void 0;
    var tslib_1 = (init_tslib_es6(), __toCommonJS(tslib_es6_exports));
    var asn1_schema_1 = require_cjs2();
    var OtherKeyAttribute = class {
      keyAttrId = "";
      keyAttr;
      constructor(params = {}) {
        Object.assign(this, params);
      }
    };
    exports.OtherKeyAttribute = OtherKeyAttribute;
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({ type: asn1_schema_1.AsnPropTypes.ObjectIdentifier })
    ], OtherKeyAttribute.prototype, "keyAttrId", void 0);
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({
        type: asn1_schema_1.AsnPropTypes.Any,
        optional: true
      })
    ], OtherKeyAttribute.prototype, "keyAttr", void 0);
  }
});

// node_modules/@peculiar/asn1-cms/build/cjs/key_agree_recipient_info.js
var require_key_agree_recipient_info = __commonJS({
  "node_modules/@peculiar/asn1-cms/build/cjs/key_agree_recipient_info.js"(exports) {
    "use strict";
    var RecipientEncryptedKeys_1;
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.KeyAgreeRecipientInfo = exports.OriginatorIdentifierOrKey = exports.OriginatorPublicKey = exports.RecipientEncryptedKeys = exports.RecipientEncryptedKey = exports.KeyAgreeRecipientIdentifier = exports.RecipientKeyIdentifier = void 0;
    var tslib_1 = (init_tslib_es6(), __toCommonJS(tslib_es6_exports));
    var asn1_schema_1 = require_cjs2();
    var asn1_x509_1 = require_cjs3();
    var types_1 = require_types3();
    var issuer_and_serial_number_1 = require_issuer_and_serial_number();
    var other_key_attribute_1 = require_other_key_attribute();
    var RecipientKeyIdentifier = class {
      subjectKeyIdentifier = new asn1_x509_1.SubjectKeyIdentifier();
      date;
      other;
      constructor(params = {}) {
        Object.assign(this, params);
      }
    };
    exports.RecipientKeyIdentifier = RecipientKeyIdentifier;
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({ type: asn1_x509_1.SubjectKeyIdentifier })
    ], RecipientKeyIdentifier.prototype, "subjectKeyIdentifier", void 0);
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({
        type: asn1_schema_1.AsnPropTypes.GeneralizedTime,
        optional: true
      })
    ], RecipientKeyIdentifier.prototype, "date", void 0);
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({
        type: other_key_attribute_1.OtherKeyAttribute,
        optional: true
      })
    ], RecipientKeyIdentifier.prototype, "other", void 0);
    var KeyAgreeRecipientIdentifier = class KeyAgreeRecipientIdentifier {
      rKeyId;
      issuerAndSerialNumber;
      constructor(params = {}) {
        Object.assign(this, params);
      }
    };
    exports.KeyAgreeRecipientIdentifier = KeyAgreeRecipientIdentifier;
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({
        type: RecipientKeyIdentifier,
        context: 0,
        implicit: true,
        optional: true
      })
    ], KeyAgreeRecipientIdentifier.prototype, "rKeyId", void 0);
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({
        type: issuer_and_serial_number_1.IssuerAndSerialNumber,
        optional: true
      })
    ], KeyAgreeRecipientIdentifier.prototype, "issuerAndSerialNumber", void 0);
    exports.KeyAgreeRecipientIdentifier = KeyAgreeRecipientIdentifier = tslib_1.__decorate([
      (0, asn1_schema_1.AsnType)({ type: asn1_schema_1.AsnTypeTypes.Choice })
    ], KeyAgreeRecipientIdentifier);
    var RecipientEncryptedKey = class {
      rid = new KeyAgreeRecipientIdentifier();
      encryptedKey = new asn1_schema_1.OctetString();
      constructor(params = {}) {
        Object.assign(this, params);
      }
    };
    exports.RecipientEncryptedKey = RecipientEncryptedKey;
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({ type: KeyAgreeRecipientIdentifier })
    ], RecipientEncryptedKey.prototype, "rid", void 0);
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({ type: asn1_schema_1.OctetString })
    ], RecipientEncryptedKey.prototype, "encryptedKey", void 0);
    var RecipientEncryptedKeys = RecipientEncryptedKeys_1 = class RecipientEncryptedKeys extends asn1_schema_1.AsnArray {
      constructor(items) {
        super(items);
        Object.setPrototypeOf(this, RecipientEncryptedKeys_1.prototype);
      }
    };
    exports.RecipientEncryptedKeys = RecipientEncryptedKeys;
    exports.RecipientEncryptedKeys = RecipientEncryptedKeys = RecipientEncryptedKeys_1 = tslib_1.__decorate([
      (0, asn1_schema_1.AsnType)({
        type: asn1_schema_1.AsnTypeTypes.Sequence,
        itemType: RecipientEncryptedKey
      })
    ], RecipientEncryptedKeys);
    var OriginatorPublicKey = class {
      algorithm = new asn1_x509_1.AlgorithmIdentifier();
      publicKey = new ArrayBuffer(0);
      constructor(params = {}) {
        Object.assign(this, params);
      }
    };
    exports.OriginatorPublicKey = OriginatorPublicKey;
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({ type: asn1_x509_1.AlgorithmIdentifier })
    ], OriginatorPublicKey.prototype, "algorithm", void 0);
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({ type: asn1_schema_1.AsnPropTypes.BitString })
    ], OriginatorPublicKey.prototype, "publicKey", void 0);
    var OriginatorIdentifierOrKey = class OriginatorIdentifierOrKey {
      subjectKeyIdentifier;
      originatorKey;
      issuerAndSerialNumber;
      constructor(params = {}) {
        Object.assign(this, params);
      }
    };
    exports.OriginatorIdentifierOrKey = OriginatorIdentifierOrKey;
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({
        type: asn1_x509_1.SubjectKeyIdentifier,
        context: 0,
        implicit: true,
        optional: true
      })
    ], OriginatorIdentifierOrKey.prototype, "subjectKeyIdentifier", void 0);
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({
        type: OriginatorPublicKey,
        context: 1,
        implicit: true,
        optional: true
      })
    ], OriginatorIdentifierOrKey.prototype, "originatorKey", void 0);
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({
        type: issuer_and_serial_number_1.IssuerAndSerialNumber,
        optional: true
      })
    ], OriginatorIdentifierOrKey.prototype, "issuerAndSerialNumber", void 0);
    exports.OriginatorIdentifierOrKey = OriginatorIdentifierOrKey = tslib_1.__decorate([
      (0, asn1_schema_1.AsnType)({ type: asn1_schema_1.AsnTypeTypes.Choice })
    ], OriginatorIdentifierOrKey);
    var KeyAgreeRecipientInfo = class {
      version = types_1.CMSVersion.v3;
      originator = new OriginatorIdentifierOrKey();
      ukm;
      keyEncryptionAlgorithm = new types_1.KeyEncryptionAlgorithmIdentifier();
      recipientEncryptedKeys = new RecipientEncryptedKeys();
      constructor(params = {}) {
        Object.assign(this, params);
      }
    };
    exports.KeyAgreeRecipientInfo = KeyAgreeRecipientInfo;
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({ type: asn1_schema_1.AsnPropTypes.Integer })
    ], KeyAgreeRecipientInfo.prototype, "version", void 0);
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({
        type: OriginatorIdentifierOrKey,
        context: 0
      })
    ], KeyAgreeRecipientInfo.prototype, "originator", void 0);
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({
        type: asn1_schema_1.OctetString,
        context: 1,
        optional: true
      })
    ], KeyAgreeRecipientInfo.prototype, "ukm", void 0);
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({ type: types_1.KeyEncryptionAlgorithmIdentifier })
    ], KeyAgreeRecipientInfo.prototype, "keyEncryptionAlgorithm", void 0);
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({ type: RecipientEncryptedKeys })
    ], KeyAgreeRecipientInfo.prototype, "recipientEncryptedKeys", void 0);
  }
});

// node_modules/@peculiar/asn1-cms/build/cjs/key_trans_recipient_info.js
var require_key_trans_recipient_info = __commonJS({
  "node_modules/@peculiar/asn1-cms/build/cjs/key_trans_recipient_info.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.KeyTransRecipientInfo = exports.RecipientIdentifier = void 0;
    var tslib_1 = (init_tslib_es6(), __toCommonJS(tslib_es6_exports));
    var asn1_schema_1 = require_cjs2();
    var asn1_x509_1 = require_cjs3();
    var types_1 = require_types3();
    var issuer_and_serial_number_1 = require_issuer_and_serial_number();
    var RecipientIdentifier = class RecipientIdentifier {
      subjectKeyIdentifier;
      issuerAndSerialNumber;
      constructor(params = {}) {
        Object.assign(this, params);
      }
    };
    exports.RecipientIdentifier = RecipientIdentifier;
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({
        type: asn1_x509_1.SubjectKeyIdentifier,
        context: 0,
        implicit: true
      })
    ], RecipientIdentifier.prototype, "subjectKeyIdentifier", void 0);
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({ type: issuer_and_serial_number_1.IssuerAndSerialNumber })
    ], RecipientIdentifier.prototype, "issuerAndSerialNumber", void 0);
    exports.RecipientIdentifier = RecipientIdentifier = tslib_1.__decorate([
      (0, asn1_schema_1.AsnType)({ type: asn1_schema_1.AsnTypeTypes.Choice })
    ], RecipientIdentifier);
    var KeyTransRecipientInfo = class {
      version = types_1.CMSVersion.v0;
      rid = new RecipientIdentifier();
      keyEncryptionAlgorithm = new types_1.KeyEncryptionAlgorithmIdentifier();
      encryptedKey = new asn1_schema_1.OctetString();
      constructor(params = {}) {
        Object.assign(this, params);
      }
    };
    exports.KeyTransRecipientInfo = KeyTransRecipientInfo;
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({ type: asn1_schema_1.AsnPropTypes.Integer })
    ], KeyTransRecipientInfo.prototype, "version", void 0);
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({ type: RecipientIdentifier })
    ], KeyTransRecipientInfo.prototype, "rid", void 0);
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({ type: types_1.KeyEncryptionAlgorithmIdentifier })
    ], KeyTransRecipientInfo.prototype, "keyEncryptionAlgorithm", void 0);
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({ type: asn1_schema_1.OctetString })
    ], KeyTransRecipientInfo.prototype, "encryptedKey", void 0);
  }
});

// node_modules/@peculiar/asn1-cms/build/cjs/kek_recipient_info.js
var require_kek_recipient_info = __commonJS({
  "node_modules/@peculiar/asn1-cms/build/cjs/kek_recipient_info.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.KEKRecipientInfo = exports.KEKIdentifier = void 0;
    var tslib_1 = (init_tslib_es6(), __toCommonJS(tslib_es6_exports));
    var asn1_schema_1 = require_cjs2();
    var other_key_attribute_1 = require_other_key_attribute();
    var types_1 = require_types3();
    var KEKIdentifier = class {
      keyIdentifier = new asn1_schema_1.OctetString();
      date;
      other;
      constructor(params = {}) {
        Object.assign(this, params);
      }
    };
    exports.KEKIdentifier = KEKIdentifier;
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({ type: asn1_schema_1.OctetString })
    ], KEKIdentifier.prototype, "keyIdentifier", void 0);
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({
        type: asn1_schema_1.AsnPropTypes.GeneralizedTime,
        optional: true
      })
    ], KEKIdentifier.prototype, "date", void 0);
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({
        type: other_key_attribute_1.OtherKeyAttribute,
        optional: true
      })
    ], KEKIdentifier.prototype, "other", void 0);
    var KEKRecipientInfo = class {
      version = types_1.CMSVersion.v4;
      kekid = new KEKIdentifier();
      keyEncryptionAlgorithm = new types_1.KeyEncryptionAlgorithmIdentifier();
      encryptedKey = new asn1_schema_1.OctetString();
      constructor(params = {}) {
        Object.assign(this, params);
      }
    };
    exports.KEKRecipientInfo = KEKRecipientInfo;
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({ type: asn1_schema_1.AsnPropTypes.Integer })
    ], KEKRecipientInfo.prototype, "version", void 0);
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({ type: KEKIdentifier })
    ], KEKRecipientInfo.prototype, "kekid", void 0);
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({ type: types_1.KeyEncryptionAlgorithmIdentifier })
    ], KEKRecipientInfo.prototype, "keyEncryptionAlgorithm", void 0);
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({ type: asn1_schema_1.OctetString })
    ], KEKRecipientInfo.prototype, "encryptedKey", void 0);
  }
});

// node_modules/@peculiar/asn1-cms/build/cjs/password_recipient_info.js
var require_password_recipient_info = __commonJS({
  "node_modules/@peculiar/asn1-cms/build/cjs/password_recipient_info.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.PasswordRecipientInfo = void 0;
    var tslib_1 = (init_tslib_es6(), __toCommonJS(tslib_es6_exports));
    var asn1_schema_1 = require_cjs2();
    var types_1 = require_types3();
    var PasswordRecipientInfo = class {
      version = types_1.CMSVersion.v0;
      keyDerivationAlgorithm;
      keyEncryptionAlgorithm = new types_1.KeyEncryptionAlgorithmIdentifier();
      encryptedKey = new asn1_schema_1.OctetString();
      constructor(params = {}) {
        Object.assign(this, params);
      }
    };
    exports.PasswordRecipientInfo = PasswordRecipientInfo;
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({ type: asn1_schema_1.AsnPropTypes.Integer })
    ], PasswordRecipientInfo.prototype, "version", void 0);
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({
        type: types_1.KeyDerivationAlgorithmIdentifier,
        context: 0,
        optional: true
      })
    ], PasswordRecipientInfo.prototype, "keyDerivationAlgorithm", void 0);
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({ type: types_1.KeyEncryptionAlgorithmIdentifier })
    ], PasswordRecipientInfo.prototype, "keyEncryptionAlgorithm", void 0);
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({ type: asn1_schema_1.OctetString })
    ], PasswordRecipientInfo.prototype, "encryptedKey", void 0);
  }
});

// node_modules/@peculiar/asn1-cms/build/cjs/recipient_info.js
var require_recipient_info = __commonJS({
  "node_modules/@peculiar/asn1-cms/build/cjs/recipient_info.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.RecipientInfo = exports.OtherRecipientInfo = void 0;
    var tslib_1 = (init_tslib_es6(), __toCommonJS(tslib_es6_exports));
    var asn1_schema_1 = require_cjs2();
    var key_agree_recipient_info_1 = require_key_agree_recipient_info();
    var key_trans_recipient_info_1 = require_key_trans_recipient_info();
    var kek_recipient_info_1 = require_kek_recipient_info();
    var password_recipient_info_1 = require_password_recipient_info();
    var OtherRecipientInfo = class {
      oriType = "";
      oriValue = new ArrayBuffer(0);
      constructor(params = {}) {
        Object.assign(this, params);
      }
    };
    exports.OtherRecipientInfo = OtherRecipientInfo;
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({ type: asn1_schema_1.AsnPropTypes.ObjectIdentifier })
    ], OtherRecipientInfo.prototype, "oriType", void 0);
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({ type: asn1_schema_1.AsnPropTypes.Any })
    ], OtherRecipientInfo.prototype, "oriValue", void 0);
    var RecipientInfo = class RecipientInfo {
      ktri;
      kari;
      kekri;
      pwri;
      ori;
      constructor(params = {}) {
        Object.assign(this, params);
      }
    };
    exports.RecipientInfo = RecipientInfo;
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({
        type: key_trans_recipient_info_1.KeyTransRecipientInfo,
        optional: true
      })
    ], RecipientInfo.prototype, "ktri", void 0);
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({
        type: key_agree_recipient_info_1.KeyAgreeRecipientInfo,
        context: 1,
        implicit: true,
        optional: true
      })
    ], RecipientInfo.prototype, "kari", void 0);
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({
        type: kek_recipient_info_1.KEKRecipientInfo,
        context: 2,
        implicit: true,
        optional: true
      })
    ], RecipientInfo.prototype, "kekri", void 0);
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({
        type: password_recipient_info_1.PasswordRecipientInfo,
        context: 3,
        implicit: true,
        optional: true
      })
    ], RecipientInfo.prototype, "pwri", void 0);
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({
        type: OtherRecipientInfo,
        context: 4,
        implicit: true,
        optional: true
      })
    ], RecipientInfo.prototype, "ori", void 0);
    exports.RecipientInfo = RecipientInfo = tslib_1.__decorate([
      (0, asn1_schema_1.AsnType)({ type: asn1_schema_1.AsnTypeTypes.Choice })
    ], RecipientInfo);
  }
});

// node_modules/@peculiar/asn1-cms/build/cjs/recipient_infos.js
var require_recipient_infos = __commonJS({
  "node_modules/@peculiar/asn1-cms/build/cjs/recipient_infos.js"(exports) {
    "use strict";
    var RecipientInfos_1;
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.RecipientInfos = void 0;
    var tslib_1 = (init_tslib_es6(), __toCommonJS(tslib_es6_exports));
    var asn1_schema_1 = require_cjs2();
    var recipient_info_1 = require_recipient_info();
    var RecipientInfos = RecipientInfos_1 = class RecipientInfos extends asn1_schema_1.AsnArray {
      constructor(items) {
        super(items);
        Object.setPrototypeOf(this, RecipientInfos_1.prototype);
      }
    };
    exports.RecipientInfos = RecipientInfos;
    exports.RecipientInfos = RecipientInfos = RecipientInfos_1 = tslib_1.__decorate([
      (0, asn1_schema_1.AsnType)({
        type: asn1_schema_1.AsnTypeTypes.Set,
        itemType: recipient_info_1.RecipientInfo
      })
    ], RecipientInfos);
  }
});

// node_modules/@peculiar/asn1-cms/build/cjs/revocation_info_choice.js
var require_revocation_info_choice = __commonJS({
  "node_modules/@peculiar/asn1-cms/build/cjs/revocation_info_choice.js"(exports) {
    "use strict";
    var RevocationInfoChoices_1;
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.RevocationInfoChoices = exports.RevocationInfoChoice = exports.OtherRevocationInfoFormat = exports.id_ri_scvp = exports.id_ri_ocsp_response = exports.id_ri = void 0;
    var tslib_1 = (init_tslib_es6(), __toCommonJS(tslib_es6_exports));
    var asn1_schema_1 = require_cjs2();
    var asn1_x509_1 = require_cjs3();
    exports.id_ri = `${asn1_x509_1.id_pkix}.16`;
    exports.id_ri_ocsp_response = `${exports.id_ri}.2`;
    exports.id_ri_scvp = `${exports.id_ri}.4`;
    var OtherRevocationInfoFormat = class {
      otherRevInfoFormat = "";
      otherRevInfo = new ArrayBuffer(0);
      constructor(params = {}) {
        Object.assign(this, params);
      }
    };
    exports.OtherRevocationInfoFormat = OtherRevocationInfoFormat;
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({ type: asn1_schema_1.AsnPropTypes.ObjectIdentifier })
    ], OtherRevocationInfoFormat.prototype, "otherRevInfoFormat", void 0);
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({ type: asn1_schema_1.AsnPropTypes.Any })
    ], OtherRevocationInfoFormat.prototype, "otherRevInfo", void 0);
    var RevocationInfoChoice = class RevocationInfoChoice {
      other = new OtherRevocationInfoFormat();
      constructor(params = {}) {
        Object.assign(this, params);
      }
    };
    exports.RevocationInfoChoice = RevocationInfoChoice;
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({
        type: OtherRevocationInfoFormat,
        context: 1,
        implicit: true
      })
    ], RevocationInfoChoice.prototype, "other", void 0);
    exports.RevocationInfoChoice = RevocationInfoChoice = tslib_1.__decorate([
      (0, asn1_schema_1.AsnType)({ type: asn1_schema_1.AsnTypeTypes.Choice })
    ], RevocationInfoChoice);
    var RevocationInfoChoices = RevocationInfoChoices_1 = class RevocationInfoChoices extends asn1_schema_1.AsnArray {
      constructor(items) {
        super(items);
        Object.setPrototypeOf(this, RevocationInfoChoices_1.prototype);
      }
    };
    exports.RevocationInfoChoices = RevocationInfoChoices;
    exports.RevocationInfoChoices = RevocationInfoChoices = RevocationInfoChoices_1 = tslib_1.__decorate([
      (0, asn1_schema_1.AsnType)({
        type: asn1_schema_1.AsnTypeTypes.Set,
        itemType: RevocationInfoChoice
      })
    ], RevocationInfoChoices);
  }
});

// node_modules/@peculiar/asn1-cms/build/cjs/originator_info.js
var require_originator_info = __commonJS({
  "node_modules/@peculiar/asn1-cms/build/cjs/originator_info.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.OriginatorInfo = void 0;
    var tslib_1 = (init_tslib_es6(), __toCommonJS(tslib_es6_exports));
    var asn1_schema_1 = require_cjs2();
    var certificate_choices_1 = require_certificate_choices();
    var revocation_info_choice_1 = require_revocation_info_choice();
    var OriginatorInfo = class {
      certs;
      crls;
      constructor(params = {}) {
        Object.assign(this, params);
      }
    };
    exports.OriginatorInfo = OriginatorInfo;
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({
        type: certificate_choices_1.CertificateSet,
        context: 0,
        implicit: true,
        optional: true
      })
    ], OriginatorInfo.prototype, "certs", void 0);
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({
        type: revocation_info_choice_1.RevocationInfoChoices,
        context: 1,
        implicit: true,
        optional: true
      })
    ], OriginatorInfo.prototype, "crls", void 0);
  }
});

// node_modules/@peculiar/asn1-cms/build/cjs/enveloped_data.js
var require_enveloped_data = __commonJS({
  "node_modules/@peculiar/asn1-cms/build/cjs/enveloped_data.js"(exports) {
    "use strict";
    var UnprotectedAttributes_1;
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.EnvelopedData = exports.UnprotectedAttributes = void 0;
    var tslib_1 = (init_tslib_es6(), __toCommonJS(tslib_es6_exports));
    var asn1_schema_1 = require_cjs2();
    var types_1 = require_types3();
    var attribute_1 = require_attribute2();
    var recipient_infos_1 = require_recipient_infos();
    var originator_info_1 = require_originator_info();
    var encrypted_content_info_1 = require_encrypted_content_info();
    var UnprotectedAttributes = UnprotectedAttributes_1 = class UnprotectedAttributes extends asn1_schema_1.AsnArray {
      constructor(items) {
        super(items);
        Object.setPrototypeOf(this, UnprotectedAttributes_1.prototype);
      }
    };
    exports.UnprotectedAttributes = UnprotectedAttributes;
    exports.UnprotectedAttributes = UnprotectedAttributes = UnprotectedAttributes_1 = tslib_1.__decorate([
      (0, asn1_schema_1.AsnType)({
        type: asn1_schema_1.AsnTypeTypes.Set,
        itemType: attribute_1.Attribute
      })
    ], UnprotectedAttributes);
    var EnvelopedData = class {
      version = types_1.CMSVersion.v0;
      originatorInfo;
      recipientInfos = new recipient_infos_1.RecipientInfos();
      encryptedContentInfo = new encrypted_content_info_1.EncryptedContentInfo();
      unprotectedAttrs;
      constructor(params = {}) {
        Object.assign(this, params);
      }
    };
    exports.EnvelopedData = EnvelopedData;
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({ type: asn1_schema_1.AsnPropTypes.Integer })
    ], EnvelopedData.prototype, "version", void 0);
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({
        type: originator_info_1.OriginatorInfo,
        context: 0,
        implicit: true,
        optional: true
      })
    ], EnvelopedData.prototype, "originatorInfo", void 0);
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({ type: recipient_infos_1.RecipientInfos })
    ], EnvelopedData.prototype, "recipientInfos", void 0);
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({ type: encrypted_content_info_1.EncryptedContentInfo })
    ], EnvelopedData.prototype, "encryptedContentInfo", void 0);
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({
        type: UnprotectedAttributes,
        context: 1,
        implicit: true,
        optional: true
      })
    ], EnvelopedData.prototype, "unprotectedAttrs", void 0);
  }
});

// node_modules/@peculiar/asn1-cms/build/cjs/object_identifiers.js
var require_object_identifiers3 = __commonJS({
  "node_modules/@peculiar/asn1-cms/build/cjs/object_identifiers.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.id_authData = exports.id_encryptedData = exports.id_digestedData = exports.id_envelopedData = exports.id_signedData = exports.id_data = exports.id_ct_contentInfo = void 0;
    exports.id_ct_contentInfo = "1.2.840.113549.1.9.16.1.6";
    exports.id_data = "1.2.840.113549.1.7.1";
    exports.id_signedData = "1.2.840.113549.1.7.2";
    exports.id_envelopedData = "1.2.840.113549.1.7.3";
    exports.id_digestedData = "1.2.840.113549.1.7.5";
    exports.id_encryptedData = "1.2.840.113549.1.7.6";
    exports.id_authData = "1.2.840.113549.1.9.16.1.2";
  }
});

// node_modules/@peculiar/asn1-cms/build/cjs/signed_data.js
var require_signed_data = __commonJS({
  "node_modules/@peculiar/asn1-cms/build/cjs/signed_data.js"(exports) {
    "use strict";
    var DigestAlgorithmIdentifiers_1;
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.SignedData = exports.DigestAlgorithmIdentifiers = void 0;
    var tslib_1 = (init_tslib_es6(), __toCommonJS(tslib_es6_exports));
    var asn1_schema_1 = require_cjs2();
    var certificate_choices_1 = require_certificate_choices();
    var types_1 = require_types3();
    var encapsulated_content_info_1 = require_encapsulated_content_info();
    var revocation_info_choice_1 = require_revocation_info_choice();
    var signer_info_1 = require_signer_info();
    var DigestAlgorithmIdentifiers = DigestAlgorithmIdentifiers_1 = class DigestAlgorithmIdentifiers extends asn1_schema_1.AsnArray {
      constructor(items) {
        super(items);
        Object.setPrototypeOf(this, DigestAlgorithmIdentifiers_1.prototype);
      }
    };
    exports.DigestAlgorithmIdentifiers = DigestAlgorithmIdentifiers;
    exports.DigestAlgorithmIdentifiers = DigestAlgorithmIdentifiers = DigestAlgorithmIdentifiers_1 = tslib_1.__decorate([
      (0, asn1_schema_1.AsnType)({
        type: asn1_schema_1.AsnTypeTypes.Set,
        itemType: types_1.DigestAlgorithmIdentifier
      })
    ], DigestAlgorithmIdentifiers);
    var SignedData = class {
      version = types_1.CMSVersion.v0;
      digestAlgorithms = new DigestAlgorithmIdentifiers();
      encapContentInfo = new encapsulated_content_info_1.EncapsulatedContentInfo();
      certificates;
      crls;
      signerInfos = new signer_info_1.SignerInfos();
      constructor(params = {}) {
        Object.assign(this, params);
      }
    };
    exports.SignedData = SignedData;
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({ type: asn1_schema_1.AsnPropTypes.Integer })
    ], SignedData.prototype, "version", void 0);
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({ type: DigestAlgorithmIdentifiers })
    ], SignedData.prototype, "digestAlgorithms", void 0);
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({ type: encapsulated_content_info_1.EncapsulatedContentInfo })
    ], SignedData.prototype, "encapContentInfo", void 0);
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({
        type: certificate_choices_1.CertificateSet,
        context: 0,
        implicit: true,
        optional: true
      })
    ], SignedData.prototype, "certificates", void 0);
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({
        type: revocation_info_choice_1.RevocationInfoChoices,
        context: 1,
        implicit: true,
        optional: true
      })
    ], SignedData.prototype, "crls", void 0);
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({ type: signer_info_1.SignerInfos })
    ], SignedData.prototype, "signerInfos", void 0);
  }
});

// node_modules/@peculiar/asn1-cms/build/cjs/index.js
var require_cjs5 = __commonJS({
  "node_modules/@peculiar/asn1-cms/build/cjs/index.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    var tslib_1 = (init_tslib_es6(), __toCommonJS(tslib_es6_exports));
    tslib_1.__exportStar(require_attributes(), exports);
    tslib_1.__exportStar(require_attribute2(), exports);
    tslib_1.__exportStar(require_certificate_choices(), exports);
    tslib_1.__exportStar(require_content_info(), exports);
    tslib_1.__exportStar(require_encapsulated_content_info(), exports);
    tslib_1.__exportStar(require_encrypted_content_info(), exports);
    tslib_1.__exportStar(require_enveloped_data(), exports);
    tslib_1.__exportStar(require_issuer_and_serial_number(), exports);
    tslib_1.__exportStar(require_kek_recipient_info(), exports);
    tslib_1.__exportStar(require_key_agree_recipient_info(), exports);
    tslib_1.__exportStar(require_key_trans_recipient_info(), exports);
    tslib_1.__exportStar(require_object_identifiers3(), exports);
    tslib_1.__exportStar(require_originator_info(), exports);
    tslib_1.__exportStar(require_password_recipient_info(), exports);
    tslib_1.__exportStar(require_recipient_info(), exports);
    tslib_1.__exportStar(require_recipient_infos(), exports);
    tslib_1.__exportStar(require_revocation_info_choice(), exports);
    tslib_1.__exportStar(require_signed_data(), exports);
    tslib_1.__exportStar(require_signer_identifier(), exports);
    tslib_1.__exportStar(require_signer_info(), exports);
    tslib_1.__exportStar(require_types3(), exports);
  }
});

// node_modules/@peculiar/asn1-ecc/build/cjs/object_identifiers.js
var require_object_identifiers4 = __commonJS({
  "node_modules/@peculiar/asn1-ecc/build/cjs/object_identifiers.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.id_sect571r1 = exports.id_sect571k1 = exports.id_secp521r1 = exports.id_sect409r1 = exports.id_sect409k1 = exports.id_secp384r1 = exports.id_sect283r1 = exports.id_sect283k1 = exports.id_secp256r1 = exports.id_sect233r1 = exports.id_sect233k1 = exports.id_secp224r1 = exports.id_sect163r2 = exports.id_sect163k1 = exports.id_secp192r1 = exports.id_ecdsaWithSHA512 = exports.id_ecdsaWithSHA384 = exports.id_ecdsaWithSHA256 = exports.id_ecdsaWithSHA224 = exports.id_ecdsaWithSHA1 = exports.id_ecMQV = exports.id_ecDH = exports.id_ecPublicKey = void 0;
    exports.id_ecPublicKey = "1.2.840.10045.2.1";
    exports.id_ecDH = "1.3.132.1.12";
    exports.id_ecMQV = "1.3.132.1.13";
    exports.id_ecdsaWithSHA1 = "1.2.840.10045.4.1";
    exports.id_ecdsaWithSHA224 = "1.2.840.10045.4.3.1";
    exports.id_ecdsaWithSHA256 = "1.2.840.10045.4.3.2";
    exports.id_ecdsaWithSHA384 = "1.2.840.10045.4.3.3";
    exports.id_ecdsaWithSHA512 = "1.2.840.10045.4.3.4";
    exports.id_secp192r1 = "1.2.840.10045.3.1.1";
    exports.id_sect163k1 = "1.3.132.0.1";
    exports.id_sect163r2 = "1.3.132.0.15";
    exports.id_secp224r1 = "1.3.132.0.33";
    exports.id_sect233k1 = "1.3.132.0.26";
    exports.id_sect233r1 = "1.3.132.0.27";
    exports.id_secp256r1 = "1.2.840.10045.3.1.7";
    exports.id_sect283k1 = "1.3.132.0.16";
    exports.id_sect283r1 = "1.3.132.0.17";
    exports.id_secp384r1 = "1.3.132.0.34";
    exports.id_sect409k1 = "1.3.132.0.36";
    exports.id_sect409r1 = "1.3.132.0.37";
    exports.id_secp521r1 = "1.3.132.0.35";
    exports.id_sect571k1 = "1.3.132.0.38";
    exports.id_sect571r1 = "1.3.132.0.39";
  }
});

// node_modules/@peculiar/asn1-ecc/build/cjs/algorithms.js
var require_algorithms = __commonJS({
  "node_modules/@peculiar/asn1-ecc/build/cjs/algorithms.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.ecdsaWithSHA512 = exports.ecdsaWithSHA384 = exports.ecdsaWithSHA256 = exports.ecdsaWithSHA224 = exports.ecdsaWithSHA1 = void 0;
    var tslib_1 = (init_tslib_es6(), __toCommonJS(tslib_es6_exports));
    var asn1_x509_1 = require_cjs3();
    var oid = tslib_1.__importStar(require_object_identifiers4());
    function create(algorithm) {
      return new asn1_x509_1.AlgorithmIdentifier({ algorithm });
    }
    exports.ecdsaWithSHA1 = create(oid.id_ecdsaWithSHA1);
    exports.ecdsaWithSHA224 = create(oid.id_ecdsaWithSHA224);
    exports.ecdsaWithSHA256 = create(oid.id_ecdsaWithSHA256);
    exports.ecdsaWithSHA384 = create(oid.id_ecdsaWithSHA384);
    exports.ecdsaWithSHA512 = create(oid.id_ecdsaWithSHA512);
  }
});

// node_modules/@peculiar/asn1-ecc/build/cjs/rfc3279.js
var require_rfc3279 = __commonJS({
  "node_modules/@peculiar/asn1-ecc/build/cjs/rfc3279.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.SpecifiedECDomain = exports.ECPVer = exports.Curve = exports.FieldElement = exports.ECPoint = exports.FieldID = void 0;
    var tslib_1 = (init_tslib_es6(), __toCommonJS(tslib_es6_exports));
    var asn1_schema_1 = require_cjs2();
    var FieldID = class FieldID {
      fieldType;
      parameters;
      constructor(params = {}) {
        Object.assign(this, params);
      }
    };
    exports.FieldID = FieldID;
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({ type: asn1_schema_1.AsnPropTypes.ObjectIdentifier })
    ], FieldID.prototype, "fieldType", void 0);
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({ type: asn1_schema_1.AsnPropTypes.Any })
    ], FieldID.prototype, "parameters", void 0);
    exports.FieldID = FieldID = tslib_1.__decorate([
      (0, asn1_schema_1.AsnType)({ type: asn1_schema_1.AsnTypeTypes.Sequence })
    ], FieldID);
    var ECPoint = class extends asn1_schema_1.OctetString {
    };
    exports.ECPoint = ECPoint;
    var FieldElement = class extends asn1_schema_1.OctetString {
    };
    exports.FieldElement = FieldElement;
    var Curve = class Curve {
      a;
      b;
      seed;
      constructor(params = {}) {
        Object.assign(this, params);
      }
    };
    exports.Curve = Curve;
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({ type: asn1_schema_1.AsnPropTypes.OctetString })
    ], Curve.prototype, "a", void 0);
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({ type: asn1_schema_1.AsnPropTypes.OctetString })
    ], Curve.prototype, "b", void 0);
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({
        type: asn1_schema_1.AsnPropTypes.BitString,
        optional: true
      })
    ], Curve.prototype, "seed", void 0);
    exports.Curve = Curve = tslib_1.__decorate([
      (0, asn1_schema_1.AsnType)({ type: asn1_schema_1.AsnTypeTypes.Sequence })
    ], Curve);
    var ECPVer;
    (function(ECPVer2) {
      ECPVer2[ECPVer2["ecpVer1"] = 1] = "ecpVer1";
    })(ECPVer || (exports.ECPVer = ECPVer = {}));
    var SpecifiedECDomain = class SpecifiedECDomain {
      version = ECPVer.ecpVer1;
      fieldID;
      curve;
      base;
      order;
      cofactor;
      constructor(params = {}) {
        Object.assign(this, params);
      }
    };
    exports.SpecifiedECDomain = SpecifiedECDomain;
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({ type: asn1_schema_1.AsnPropTypes.Integer })
    ], SpecifiedECDomain.prototype, "version", void 0);
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({ type: FieldID })
    ], SpecifiedECDomain.prototype, "fieldID", void 0);
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({ type: Curve })
    ], SpecifiedECDomain.prototype, "curve", void 0);
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({ type: ECPoint })
    ], SpecifiedECDomain.prototype, "base", void 0);
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({
        type: asn1_schema_1.AsnPropTypes.Integer,
        converter: asn1_schema_1.AsnIntegerArrayBufferConverter
      })
    ], SpecifiedECDomain.prototype, "order", void 0);
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({
        type: asn1_schema_1.AsnPropTypes.Integer,
        optional: true
      })
    ], SpecifiedECDomain.prototype, "cofactor", void 0);
    exports.SpecifiedECDomain = SpecifiedECDomain = tslib_1.__decorate([
      (0, asn1_schema_1.AsnType)({ type: asn1_schema_1.AsnTypeTypes.Sequence })
    ], SpecifiedECDomain);
  }
});

// node_modules/@peculiar/asn1-ecc/build/cjs/ec_parameters.js
var require_ec_parameters = __commonJS({
  "node_modules/@peculiar/asn1-ecc/build/cjs/ec_parameters.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.ECParameters = void 0;
    var tslib_1 = (init_tslib_es6(), __toCommonJS(tslib_es6_exports));
    var asn1_schema_1 = require_cjs2();
    var rfc3279_1 = require_rfc3279();
    var ECParameters = class ECParameters {
      namedCurve;
      implicitCurve;
      specifiedCurve;
      constructor(params = {}) {
        Object.assign(this, params);
      }
    };
    exports.ECParameters = ECParameters;
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({ type: asn1_schema_1.AsnPropTypes.ObjectIdentifier })
    ], ECParameters.prototype, "namedCurve", void 0);
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({ type: asn1_schema_1.AsnPropTypes.Null })
    ], ECParameters.prototype, "implicitCurve", void 0);
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({ type: rfc3279_1.SpecifiedECDomain })
    ], ECParameters.prototype, "specifiedCurve", void 0);
    exports.ECParameters = ECParameters = tslib_1.__decorate([
      (0, asn1_schema_1.AsnType)({ type: asn1_schema_1.AsnTypeTypes.Choice })
    ], ECParameters);
  }
});

// node_modules/@peculiar/asn1-ecc/build/cjs/ec_private_key.js
var require_ec_private_key = __commonJS({
  "node_modules/@peculiar/asn1-ecc/build/cjs/ec_private_key.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.ECPrivateKey = void 0;
    var tslib_1 = (init_tslib_es6(), __toCommonJS(tslib_es6_exports));
    var asn1_schema_1 = require_cjs2();
    var ec_parameters_1 = require_ec_parameters();
    var ECPrivateKey = class {
      version = 1;
      privateKey = new asn1_schema_1.OctetString();
      parameters;
      publicKey;
      constructor(params = {}) {
        Object.assign(this, params);
      }
    };
    exports.ECPrivateKey = ECPrivateKey;
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({ type: asn1_schema_1.AsnPropTypes.Integer })
    ], ECPrivateKey.prototype, "version", void 0);
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({ type: asn1_schema_1.OctetString })
    ], ECPrivateKey.prototype, "privateKey", void 0);
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({
        type: ec_parameters_1.ECParameters,
        context: 0,
        optional: true
      })
    ], ECPrivateKey.prototype, "parameters", void 0);
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({
        type: asn1_schema_1.AsnPropTypes.BitString,
        context: 1,
        optional: true
      })
    ], ECPrivateKey.prototype, "publicKey", void 0);
  }
});

// node_modules/@peculiar/asn1-ecc/build/cjs/ec_signature_value.js
var require_ec_signature_value = __commonJS({
  "node_modules/@peculiar/asn1-ecc/build/cjs/ec_signature_value.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.ECDSASigValue = void 0;
    var tslib_1 = (init_tslib_es6(), __toCommonJS(tslib_es6_exports));
    var asn1_schema_1 = require_cjs2();
    var ECDSASigValue = class {
      r = new ArrayBuffer(0);
      s = new ArrayBuffer(0);
      constructor(params = {}) {
        Object.assign(this, params);
      }
    };
    exports.ECDSASigValue = ECDSASigValue;
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({
        type: asn1_schema_1.AsnPropTypes.Integer,
        converter: asn1_schema_1.AsnIntegerArrayBufferConverter
      })
    ], ECDSASigValue.prototype, "r", void 0);
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({
        type: asn1_schema_1.AsnPropTypes.Integer,
        converter: asn1_schema_1.AsnIntegerArrayBufferConverter
      })
    ], ECDSASigValue.prototype, "s", void 0);
  }
});

// node_modules/@peculiar/asn1-ecc/build/cjs/index.js
var require_cjs6 = __commonJS({
  "node_modules/@peculiar/asn1-ecc/build/cjs/index.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    var tslib_1 = (init_tslib_es6(), __toCommonJS(tslib_es6_exports));
    tslib_1.__exportStar(require_algorithms(), exports);
    tslib_1.__exportStar(require_ec_parameters(), exports);
    tslib_1.__exportStar(require_ec_private_key(), exports);
    tslib_1.__exportStar(require_ec_signature_value(), exports);
    tslib_1.__exportStar(require_object_identifiers4(), exports);
    tslib_1.__exportStar(require_rfc3279(), exports);
  }
});

// node_modules/@peculiar/asn1-rsa/build/cjs/object_identifiers.js
var require_object_identifiers5 = __commonJS({
  "node_modules/@peculiar/asn1-rsa/build/cjs/object_identifiers.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.id_mgf1 = exports.id_md5 = exports.id_md2 = exports.id_sha512_256 = exports.id_sha512_224 = exports.id_sha512 = exports.id_sha384 = exports.id_sha256 = exports.id_sha224 = exports.id_sha1 = exports.id_sha512_256WithRSAEncryption = exports.id_sha512_224WithRSAEncryption = exports.id_sha512WithRSAEncryption = exports.id_sha384WithRSAEncryption = exports.id_sha256WithRSAEncryption = exports.id_ssha224WithRSAEncryption = exports.id_sha224WithRSAEncryption = exports.id_sha1WithRSAEncryption = exports.id_md5WithRSAEncryption = exports.id_md2WithRSAEncryption = exports.id_RSASSA_PSS = exports.id_pSpecified = exports.id_RSAES_OAEP = exports.id_rsaEncryption = exports.id_pkcs_1 = void 0;
    exports.id_pkcs_1 = "1.2.840.113549.1.1";
    exports.id_rsaEncryption = `${exports.id_pkcs_1}.1`;
    exports.id_RSAES_OAEP = `${exports.id_pkcs_1}.7`;
    exports.id_pSpecified = `${exports.id_pkcs_1}.9`;
    exports.id_RSASSA_PSS = `${exports.id_pkcs_1}.10`;
    exports.id_md2WithRSAEncryption = `${exports.id_pkcs_1}.2`;
    exports.id_md5WithRSAEncryption = `${exports.id_pkcs_1}.4`;
    exports.id_sha1WithRSAEncryption = `${exports.id_pkcs_1}.5`;
    exports.id_sha224WithRSAEncryption = `${exports.id_pkcs_1}.14`;
    exports.id_ssha224WithRSAEncryption = exports.id_sha224WithRSAEncryption;
    exports.id_sha256WithRSAEncryption = `${exports.id_pkcs_1}.11`;
    exports.id_sha384WithRSAEncryption = `${exports.id_pkcs_1}.12`;
    exports.id_sha512WithRSAEncryption = `${exports.id_pkcs_1}.13`;
    exports.id_sha512_224WithRSAEncryption = `${exports.id_pkcs_1}.15`;
    exports.id_sha512_256WithRSAEncryption = `${exports.id_pkcs_1}.16`;
    exports.id_sha1 = "1.3.14.3.2.26";
    exports.id_sha224 = "2.16.840.1.101.3.4.2.4";
    exports.id_sha256 = "2.16.840.1.101.3.4.2.1";
    exports.id_sha384 = "2.16.840.1.101.3.4.2.2";
    exports.id_sha512 = "2.16.840.1.101.3.4.2.3";
    exports.id_sha512_224 = "2.16.840.1.101.3.4.2.5";
    exports.id_sha512_256 = "2.16.840.1.101.3.4.2.6";
    exports.id_md2 = "1.2.840.113549.2.2";
    exports.id_md5 = "1.2.840.113549.2.5";
    exports.id_mgf1 = `${exports.id_pkcs_1}.8`;
  }
});

// node_modules/@peculiar/asn1-rsa/build/cjs/algorithms.js
var require_algorithms2 = __commonJS({
  "node_modules/@peculiar/asn1-rsa/build/cjs/algorithms.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.sha512_256WithRSAEncryption = exports.sha512_224WithRSAEncryption = exports.sha512WithRSAEncryption = exports.sha384WithRSAEncryption = exports.sha256WithRSAEncryption = exports.sha224WithRSAEncryption = exports.sha1WithRSAEncryption = exports.md5WithRSAEncryption = exports.md2WithRSAEncryption = exports.rsaEncryption = exports.pSpecifiedEmpty = exports.mgf1SHA1 = exports.sha512_256 = exports.sha512_224 = exports.sha512 = exports.sha384 = exports.sha256 = exports.sha224 = exports.sha1 = exports.md4 = exports.md2 = void 0;
    var tslib_1 = (init_tslib_es6(), __toCommonJS(tslib_es6_exports));
    var asn1_schema_1 = require_cjs2();
    var asn1_x509_1 = require_cjs3();
    var oid = tslib_1.__importStar(require_object_identifiers5());
    function create(algorithm) {
      return new asn1_x509_1.AlgorithmIdentifier({
        algorithm,
        parameters: null
      });
    }
    exports.md2 = create(oid.id_md2);
    exports.md4 = create(oid.id_md5);
    exports.sha1 = create(oid.id_sha1);
    exports.sha224 = create(oid.id_sha224);
    exports.sha256 = create(oid.id_sha256);
    exports.sha384 = create(oid.id_sha384);
    exports.sha512 = create(oid.id_sha512);
    exports.sha512_224 = create(oid.id_sha512_224);
    exports.sha512_256 = create(oid.id_sha512_256);
    exports.mgf1SHA1 = new asn1_x509_1.AlgorithmIdentifier({
      algorithm: oid.id_mgf1,
      parameters: asn1_schema_1.AsnConvert.serialize(exports.sha1)
    });
    exports.pSpecifiedEmpty = new asn1_x509_1.AlgorithmIdentifier({
      algorithm: oid.id_pSpecified,
      parameters: asn1_schema_1.AsnConvert.serialize(asn1_schema_1.AsnOctetStringConverter.toASN(new Uint8Array([218, 57, 163, 238, 94, 107, 75, 13, 50, 85, 191, 239, 149, 96, 24, 144, 175, 216, 7, 9]).buffer))
    });
    exports.rsaEncryption = create(oid.id_rsaEncryption);
    exports.md2WithRSAEncryption = create(oid.id_md2WithRSAEncryption);
    exports.md5WithRSAEncryption = create(oid.id_md5WithRSAEncryption);
    exports.sha1WithRSAEncryption = create(oid.id_sha1WithRSAEncryption);
    exports.sha224WithRSAEncryption = create(oid.id_sha512_224WithRSAEncryption);
    exports.sha256WithRSAEncryption = create(oid.id_sha512_256WithRSAEncryption);
    exports.sha384WithRSAEncryption = create(oid.id_sha384WithRSAEncryption);
    exports.sha512WithRSAEncryption = create(oid.id_sha512WithRSAEncryption);
    exports.sha512_224WithRSAEncryption = create(oid.id_sha512_224WithRSAEncryption);
    exports.sha512_256WithRSAEncryption = create(oid.id_sha512_256WithRSAEncryption);
  }
});

// node_modules/@peculiar/asn1-rsa/build/cjs/parameters/rsaes_oaep.js
var require_rsaes_oaep = __commonJS({
  "node_modules/@peculiar/asn1-rsa/build/cjs/parameters/rsaes_oaep.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.RSAES_OAEP = exports.RsaEsOaepParams = void 0;
    var tslib_1 = (init_tslib_es6(), __toCommonJS(tslib_es6_exports));
    var asn1_schema_1 = require_cjs2();
    var asn1_x509_1 = require_cjs3();
    var object_identifiers_1 = require_object_identifiers5();
    var algorithms_1 = require_algorithms2();
    var RsaEsOaepParams = class {
      hashAlgorithm = new asn1_x509_1.AlgorithmIdentifier(algorithms_1.sha1);
      maskGenAlgorithm = new asn1_x509_1.AlgorithmIdentifier({
        algorithm: object_identifiers_1.id_mgf1,
        parameters: asn1_schema_1.AsnConvert.serialize(algorithms_1.sha1)
      });
      pSourceAlgorithm = new asn1_x509_1.AlgorithmIdentifier(algorithms_1.pSpecifiedEmpty);
      constructor(params = {}) {
        Object.assign(this, params);
      }
    };
    exports.RsaEsOaepParams = RsaEsOaepParams;
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({
        type: asn1_x509_1.AlgorithmIdentifier,
        context: 0,
        defaultValue: algorithms_1.sha1
      })
    ], RsaEsOaepParams.prototype, "hashAlgorithm", void 0);
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({
        type: asn1_x509_1.AlgorithmIdentifier,
        context: 1,
        defaultValue: algorithms_1.mgf1SHA1
      })
    ], RsaEsOaepParams.prototype, "maskGenAlgorithm", void 0);
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({
        type: asn1_x509_1.AlgorithmIdentifier,
        context: 2,
        defaultValue: algorithms_1.pSpecifiedEmpty
      })
    ], RsaEsOaepParams.prototype, "pSourceAlgorithm", void 0);
    exports.RSAES_OAEP = new asn1_x509_1.AlgorithmIdentifier({
      algorithm: object_identifiers_1.id_RSAES_OAEP,
      parameters: asn1_schema_1.AsnConvert.serialize(new RsaEsOaepParams())
    });
  }
});

// node_modules/@peculiar/asn1-rsa/build/cjs/parameters/rsassa_pss.js
var require_rsassa_pss = __commonJS({
  "node_modules/@peculiar/asn1-rsa/build/cjs/parameters/rsassa_pss.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.RSASSA_PSS = exports.RsaSaPssParams = void 0;
    var tslib_1 = (init_tslib_es6(), __toCommonJS(tslib_es6_exports));
    var asn1_schema_1 = require_cjs2();
    var asn1_x509_1 = require_cjs3();
    var object_identifiers_1 = require_object_identifiers5();
    var algorithms_1 = require_algorithms2();
    var RsaSaPssParams = class {
      hashAlgorithm = new asn1_x509_1.AlgorithmIdentifier(algorithms_1.sha1);
      maskGenAlgorithm = new asn1_x509_1.AlgorithmIdentifier({
        algorithm: object_identifiers_1.id_mgf1,
        parameters: asn1_schema_1.AsnConvert.serialize(algorithms_1.sha1)
      });
      saltLength = 20;
      trailerField = 1;
      constructor(params = {}) {
        Object.assign(this, params);
      }
    };
    exports.RsaSaPssParams = RsaSaPssParams;
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({
        type: asn1_x509_1.AlgorithmIdentifier,
        context: 0,
        defaultValue: algorithms_1.sha1
      })
    ], RsaSaPssParams.prototype, "hashAlgorithm", void 0);
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({
        type: asn1_x509_1.AlgorithmIdentifier,
        context: 1,
        defaultValue: algorithms_1.mgf1SHA1
      })
    ], RsaSaPssParams.prototype, "maskGenAlgorithm", void 0);
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({
        type: asn1_schema_1.AsnPropTypes.Integer,
        context: 2,
        defaultValue: 20
      })
    ], RsaSaPssParams.prototype, "saltLength", void 0);
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({
        type: asn1_schema_1.AsnPropTypes.Integer,
        context: 3,
        defaultValue: 1
      })
    ], RsaSaPssParams.prototype, "trailerField", void 0);
    exports.RSASSA_PSS = new asn1_x509_1.AlgorithmIdentifier({
      algorithm: object_identifiers_1.id_RSASSA_PSS,
      parameters: asn1_schema_1.AsnConvert.serialize(new RsaSaPssParams())
    });
  }
});

// node_modules/@peculiar/asn1-rsa/build/cjs/parameters/rsassa_pkcs1_v1_5.js
var require_rsassa_pkcs1_v1_5 = __commonJS({
  "node_modules/@peculiar/asn1-rsa/build/cjs/parameters/rsassa_pkcs1_v1_5.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.DigestInfo = void 0;
    var tslib_1 = (init_tslib_es6(), __toCommonJS(tslib_es6_exports));
    var asn1_x509_1 = require_cjs3();
    var asn1_schema_1 = require_cjs2();
    var DigestInfo = class {
      digestAlgorithm = new asn1_x509_1.AlgorithmIdentifier();
      digest = new asn1_schema_1.OctetString();
      constructor(params = {}) {
        Object.assign(this, params);
      }
    };
    exports.DigestInfo = DigestInfo;
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({ type: asn1_x509_1.AlgorithmIdentifier })
    ], DigestInfo.prototype, "digestAlgorithm", void 0);
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({ type: asn1_schema_1.OctetString })
    ], DigestInfo.prototype, "digest", void 0);
  }
});

// node_modules/@peculiar/asn1-rsa/build/cjs/parameters/index.js
var require_parameters = __commonJS({
  "node_modules/@peculiar/asn1-rsa/build/cjs/parameters/index.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    var tslib_1 = (init_tslib_es6(), __toCommonJS(tslib_es6_exports));
    tslib_1.__exportStar(require_rsaes_oaep(), exports);
    tslib_1.__exportStar(require_rsassa_pss(), exports);
    tslib_1.__exportStar(require_rsassa_pkcs1_v1_5(), exports);
  }
});

// node_modules/@peculiar/asn1-rsa/build/cjs/other_prime_info.js
var require_other_prime_info = __commonJS({
  "node_modules/@peculiar/asn1-rsa/build/cjs/other_prime_info.js"(exports) {
    "use strict";
    var OtherPrimeInfos_1;
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.OtherPrimeInfos = exports.OtherPrimeInfo = void 0;
    var tslib_1 = (init_tslib_es6(), __toCommonJS(tslib_es6_exports));
    var asn1_schema_1 = require_cjs2();
    var OtherPrimeInfo = class {
      prime = new ArrayBuffer(0);
      exponent = new ArrayBuffer(0);
      coefficient = new ArrayBuffer(0);
      constructor(params = {}) {
        Object.assign(this, params);
      }
    };
    exports.OtherPrimeInfo = OtherPrimeInfo;
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({
        type: asn1_schema_1.AsnPropTypes.Integer,
        converter: asn1_schema_1.AsnIntegerArrayBufferConverter
      })
    ], OtherPrimeInfo.prototype, "prime", void 0);
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({
        type: asn1_schema_1.AsnPropTypes.Integer,
        converter: asn1_schema_1.AsnIntegerArrayBufferConverter
      })
    ], OtherPrimeInfo.prototype, "exponent", void 0);
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({
        type: asn1_schema_1.AsnPropTypes.Integer,
        converter: asn1_schema_1.AsnIntegerArrayBufferConverter
      })
    ], OtherPrimeInfo.prototype, "coefficient", void 0);
    var OtherPrimeInfos = OtherPrimeInfos_1 = class OtherPrimeInfos extends asn1_schema_1.AsnArray {
      constructor(items) {
        super(items);
        Object.setPrototypeOf(this, OtherPrimeInfos_1.prototype);
      }
    };
    exports.OtherPrimeInfos = OtherPrimeInfos;
    exports.OtherPrimeInfos = OtherPrimeInfos = OtherPrimeInfos_1 = tslib_1.__decorate([
      (0, asn1_schema_1.AsnType)({
        type: asn1_schema_1.AsnTypeTypes.Sequence,
        itemType: OtherPrimeInfo
      })
    ], OtherPrimeInfos);
  }
});

// node_modules/@peculiar/asn1-rsa/build/cjs/rsa_private_key.js
var require_rsa_private_key = __commonJS({
  "node_modules/@peculiar/asn1-rsa/build/cjs/rsa_private_key.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.RSAPrivateKey = void 0;
    var tslib_1 = (init_tslib_es6(), __toCommonJS(tslib_es6_exports));
    var asn1_schema_1 = require_cjs2();
    var other_prime_info_1 = require_other_prime_info();
    var RSAPrivateKey = class {
      version = 0;
      modulus = new ArrayBuffer(0);
      publicExponent = new ArrayBuffer(0);
      privateExponent = new ArrayBuffer(0);
      prime1 = new ArrayBuffer(0);
      prime2 = new ArrayBuffer(0);
      exponent1 = new ArrayBuffer(0);
      exponent2 = new ArrayBuffer(0);
      coefficient = new ArrayBuffer(0);
      otherPrimeInfos;
      constructor(params = {}) {
        Object.assign(this, params);
      }
    };
    exports.RSAPrivateKey = RSAPrivateKey;
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({ type: asn1_schema_1.AsnPropTypes.Integer })
    ], RSAPrivateKey.prototype, "version", void 0);
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({
        type: asn1_schema_1.AsnPropTypes.Integer,
        converter: asn1_schema_1.AsnIntegerArrayBufferConverter
      })
    ], RSAPrivateKey.prototype, "modulus", void 0);
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({
        type: asn1_schema_1.AsnPropTypes.Integer,
        converter: asn1_schema_1.AsnIntegerArrayBufferConverter
      })
    ], RSAPrivateKey.prototype, "publicExponent", void 0);
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({
        type: asn1_schema_1.AsnPropTypes.Integer,
        converter: asn1_schema_1.AsnIntegerArrayBufferConverter
      })
    ], RSAPrivateKey.prototype, "privateExponent", void 0);
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({
        type: asn1_schema_1.AsnPropTypes.Integer,
        converter: asn1_schema_1.AsnIntegerArrayBufferConverter
      })
    ], RSAPrivateKey.prototype, "prime1", void 0);
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({
        type: asn1_schema_1.AsnPropTypes.Integer,
        converter: asn1_schema_1.AsnIntegerArrayBufferConverter
      })
    ], RSAPrivateKey.prototype, "prime2", void 0);
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({
        type: asn1_schema_1.AsnPropTypes.Integer,
        converter: asn1_schema_1.AsnIntegerArrayBufferConverter
      })
    ], RSAPrivateKey.prototype, "exponent1", void 0);
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({
        type: asn1_schema_1.AsnPropTypes.Integer,
        converter: asn1_schema_1.AsnIntegerArrayBufferConverter
      })
    ], RSAPrivateKey.prototype, "exponent2", void 0);
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({
        type: asn1_schema_1.AsnPropTypes.Integer,
        converter: asn1_schema_1.AsnIntegerArrayBufferConverter
      })
    ], RSAPrivateKey.prototype, "coefficient", void 0);
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({
        type: other_prime_info_1.OtherPrimeInfos,
        optional: true
      })
    ], RSAPrivateKey.prototype, "otherPrimeInfos", void 0);
  }
});

// node_modules/@peculiar/asn1-rsa/build/cjs/rsa_public_key.js
var require_rsa_public_key = __commonJS({
  "node_modules/@peculiar/asn1-rsa/build/cjs/rsa_public_key.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.RSAPublicKey = void 0;
    var tslib_1 = (init_tslib_es6(), __toCommonJS(tslib_es6_exports));
    var asn1_schema_1 = require_cjs2();
    var RSAPublicKey = class {
      modulus = new ArrayBuffer(0);
      publicExponent = new ArrayBuffer(0);
      constructor(params = {}) {
        Object.assign(this, params);
      }
    };
    exports.RSAPublicKey = RSAPublicKey;
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({
        type: asn1_schema_1.AsnPropTypes.Integer,
        converter: asn1_schema_1.AsnIntegerArrayBufferConverter
      })
    ], RSAPublicKey.prototype, "modulus", void 0);
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({
        type: asn1_schema_1.AsnPropTypes.Integer,
        converter: asn1_schema_1.AsnIntegerArrayBufferConverter
      })
    ], RSAPublicKey.prototype, "publicExponent", void 0);
  }
});

// node_modules/@peculiar/asn1-rsa/build/cjs/index.js
var require_cjs7 = __commonJS({
  "node_modules/@peculiar/asn1-rsa/build/cjs/index.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    var tslib_1 = (init_tslib_es6(), __toCommonJS(tslib_es6_exports));
    tslib_1.__exportStar(require_parameters(), exports);
    tslib_1.__exportStar(require_algorithms2(), exports);
    tslib_1.__exportStar(require_object_identifiers5(), exports);
    tslib_1.__exportStar(require_other_prime_info(), exports);
    tslib_1.__exportStar(require_rsa_private_key(), exports);
    tslib_1.__exportStar(require_rsa_public_key(), exports);
  }
});

// node_modules/tsyringe/node_modules/tslib/tslib.es6.js
var tslib_es6_exports2 = {};
__export(tslib_es6_exports2, {
  __assign: () => __assign2,
  __asyncDelegator: () => __asyncDelegator2,
  __asyncGenerator: () => __asyncGenerator2,
  __asyncValues: () => __asyncValues2,
  __await: () => __await2,
  __awaiter: () => __awaiter2,
  __classPrivateFieldGet: () => __classPrivateFieldGet2,
  __classPrivateFieldSet: () => __classPrivateFieldSet2,
  __createBinding: () => __createBinding2,
  __decorate: () => __decorate2,
  __exportStar: () => __exportStar2,
  __extends: () => __extends2,
  __generator: () => __generator2,
  __importDefault: () => __importDefault2,
  __importStar: () => __importStar2,
  __makeTemplateObject: () => __makeTemplateObject2,
  __metadata: () => __metadata2,
  __param: () => __param2,
  __read: () => __read2,
  __rest: () => __rest2,
  __spread: () => __spread2,
  __spreadArrays: () => __spreadArrays2,
  __values: () => __values2
});
function __extends2(d, b) {
  extendStatics2(d, b);
  function __() {
    this.constructor = d;
  }
  d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
}
function __rest2(s, e) {
  var t = {};
  for (var p in s) if (Object.prototype.hasOwnProperty.call(s, p) && e.indexOf(p) < 0)
    t[p] = s[p];
  if (s != null && typeof Object.getOwnPropertySymbols === "function")
    for (var i = 0, p = Object.getOwnPropertySymbols(s); i < p.length; i++) {
      if (e.indexOf(p[i]) < 0 && Object.prototype.propertyIsEnumerable.call(s, p[i]))
        t[p[i]] = s[p[i]];
    }
  return t;
}
function __decorate2(decorators, target, key, desc) {
  var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
  if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
  else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
  return c > 3 && r && Object.defineProperty(target, key, r), r;
}
function __param2(paramIndex, decorator) {
  return function(target, key) {
    decorator(target, key, paramIndex);
  };
}
function __metadata2(metadataKey, metadataValue) {
  if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(metadataKey, metadataValue);
}
function __awaiter2(thisArg, _arguments, P, generator) {
  function adopt(value) {
    return value instanceof P ? value : new P(function(resolve) {
      resolve(value);
    });
  }
  return new (P || (P = Promise))(function(resolve, reject) {
    function fulfilled(value) {
      try {
        step(generator.next(value));
      } catch (e) {
        reject(e);
      }
    }
    function rejected(value) {
      try {
        step(generator["throw"](value));
      } catch (e) {
        reject(e);
      }
    }
    function step(result) {
      result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected);
    }
    step((generator = generator.apply(thisArg, _arguments || [])).next());
  });
}
function __generator2(thisArg, body) {
  var _ = { label: 0, sent: function() {
    if (t[0] & 1) throw t[1];
    return t[1];
  }, trys: [], ops: [] }, f, y, t, g;
  return g = { next: verb(0), "throw": verb(1), "return": verb(2) }, typeof Symbol === "function" && (g[Symbol.iterator] = function() {
    return this;
  }), g;
  function verb(n) {
    return function(v) {
      return step([n, v]);
    };
  }
  function step(op) {
    if (f) throw new TypeError("Generator is already executing.");
    while (_) try {
      if (f = 1, y && (t = op[0] & 2 ? y["return"] : op[0] ? y["throw"] || ((t = y["return"]) && t.call(y), 0) : y.next) && !(t = t.call(y, op[1])).done) return t;
      if (y = 0, t) op = [op[0] & 2, t.value];
      switch (op[0]) {
        case 0:
        case 1:
          t = op;
          break;
        case 4:
          _.label++;
          return { value: op[1], done: false };
        case 5:
          _.label++;
          y = op[1];
          op = [0];
          continue;
        case 7:
          op = _.ops.pop();
          _.trys.pop();
          continue;
        default:
          if (!(t = _.trys, t = t.length > 0 && t[t.length - 1]) && (op[0] === 6 || op[0] === 2)) {
            _ = 0;
            continue;
          }
          if (op[0] === 3 && (!t || op[1] > t[0] && op[1] < t[3])) {
            _.label = op[1];
            break;
          }
          if (op[0] === 6 && _.label < t[1]) {
            _.label = t[1];
            t = op;
            break;
          }
          if (t && _.label < t[2]) {
            _.label = t[2];
            _.ops.push(op);
            break;
          }
          if (t[2]) _.ops.pop();
          _.trys.pop();
          continue;
      }
      op = body.call(thisArg, _);
    } catch (e) {
      op = [6, e];
      y = 0;
    } finally {
      f = t = 0;
    }
    if (op[0] & 5) throw op[1];
    return { value: op[0] ? op[1] : void 0, done: true };
  }
}
function __createBinding2(o, m, k, k2) {
  if (k2 === void 0) k2 = k;
  o[k2] = m[k];
}
function __exportStar2(m, exports) {
  for (var p in m) if (p !== "default" && !exports.hasOwnProperty(p)) exports[p] = m[p];
}
function __values2(o) {
  var s = typeof Symbol === "function" && Symbol.iterator, m = s && o[s], i = 0;
  if (m) return m.call(o);
  if (o && typeof o.length === "number") return {
    next: function() {
      if (o && i >= o.length) o = void 0;
      return { value: o && o[i++], done: !o };
    }
  };
  throw new TypeError(s ? "Object is not iterable." : "Symbol.iterator is not defined.");
}
function __read2(o, n) {
  var m = typeof Symbol === "function" && o[Symbol.iterator];
  if (!m) return o;
  var i = m.call(o), r, ar = [], e;
  try {
    while ((n === void 0 || n-- > 0) && !(r = i.next()).done) ar.push(r.value);
  } catch (error) {
    e = { error };
  } finally {
    try {
      if (r && !r.done && (m = i["return"])) m.call(i);
    } finally {
      if (e) throw e.error;
    }
  }
  return ar;
}
function __spread2() {
  for (var ar = [], i = 0; i < arguments.length; i++)
    ar = ar.concat(__read2(arguments[i]));
  return ar;
}
function __spreadArrays2() {
  for (var s = 0, i = 0, il = arguments.length; i < il; i++) s += arguments[i].length;
  for (var r = Array(s), k = 0, i = 0; i < il; i++)
    for (var a = arguments[i], j = 0, jl = a.length; j < jl; j++, k++)
      r[k] = a[j];
  return r;
}
function __await2(v) {
  return this instanceof __await2 ? (this.v = v, this) : new __await2(v);
}
function __asyncGenerator2(thisArg, _arguments, generator) {
  if (!Symbol.asyncIterator) throw new TypeError("Symbol.asyncIterator is not defined.");
  var g = generator.apply(thisArg, _arguments || []), i, q = [];
  return i = {}, verb("next"), verb("throw"), verb("return"), i[Symbol.asyncIterator] = function() {
    return this;
  }, i;
  function verb(n) {
    if (g[n]) i[n] = function(v) {
      return new Promise(function(a, b) {
        q.push([n, v, a, b]) > 1 || resume(n, v);
      });
    };
  }
  function resume(n, v) {
    try {
      step(g[n](v));
    } catch (e) {
      settle(q[0][3], e);
    }
  }
  function step(r) {
    r.value instanceof __await2 ? Promise.resolve(r.value.v).then(fulfill, reject) : settle(q[0][2], r);
  }
  function fulfill(value) {
    resume("next", value);
  }
  function reject(value) {
    resume("throw", value);
  }
  function settle(f, v) {
    if (f(v), q.shift(), q.length) resume(q[0][0], q[0][1]);
  }
}
function __asyncDelegator2(o) {
  var i, p;
  return i = {}, verb("next"), verb("throw", function(e) {
    throw e;
  }), verb("return"), i[Symbol.iterator] = function() {
    return this;
  }, i;
  function verb(n, f) {
    i[n] = o[n] ? function(v) {
      return (p = !p) ? { value: __await2(o[n](v)), done: n === "return" } : f ? f(v) : v;
    } : f;
  }
}
function __asyncValues2(o) {
  if (!Symbol.asyncIterator) throw new TypeError("Symbol.asyncIterator is not defined.");
  var m = o[Symbol.asyncIterator], i;
  return m ? m.call(o) : (o = typeof __values2 === "function" ? __values2(o) : o[Symbol.iterator](), i = {}, verb("next"), verb("throw"), verb("return"), i[Symbol.asyncIterator] = function() {
    return this;
  }, i);
  function verb(n) {
    i[n] = o[n] && function(v) {
      return new Promise(function(resolve, reject) {
        v = o[n](v), settle(resolve, reject, v.done, v.value);
      });
    };
  }
  function settle(resolve, reject, d, v) {
    Promise.resolve(v).then(function(v2) {
      resolve({ value: v2, done: d });
    }, reject);
  }
}
function __makeTemplateObject2(cooked, raw) {
  if (Object.defineProperty) {
    Object.defineProperty(cooked, "raw", { value: raw });
  } else {
    cooked.raw = raw;
  }
  return cooked;
}
function __importStar2(mod) {
  if (mod && mod.__esModule) return mod;
  var result = {};
  if (mod != null) {
    for (var k in mod) if (Object.hasOwnProperty.call(mod, k)) result[k] = mod[k];
  }
  result.default = mod;
  return result;
}
function __importDefault2(mod) {
  return mod && mod.__esModule ? mod : { default: mod };
}
function __classPrivateFieldGet2(receiver, privateMap) {
  if (!privateMap.has(receiver)) {
    throw new TypeError("attempted to get private field on non-instance");
  }
  return privateMap.get(receiver);
}
function __classPrivateFieldSet2(receiver, privateMap, value) {
  if (!privateMap.has(receiver)) {
    throw new TypeError("attempted to set private field on non-instance");
  }
  privateMap.set(receiver, value);
  return value;
}
var extendStatics2, __assign2;
var init_tslib_es62 = __esm({
  "node_modules/tsyringe/node_modules/tslib/tslib.es6.js"() {
    extendStatics2 = function(d, b) {
      extendStatics2 = Object.setPrototypeOf || { __proto__: [] } instanceof Array && function(d2, b2) {
        d2.__proto__ = b2;
      } || function(d2, b2) {
        for (var p in b2) if (b2.hasOwnProperty(p)) d2[p] = b2[p];
      };
      return extendStatics2(d, b);
    };
    __assign2 = function() {
      __assign2 = Object.assign || function __assign3(t) {
        for (var s, i = 1, n = arguments.length; i < n; i++) {
          s = arguments[i];
          for (var p in s) if (Object.prototype.hasOwnProperty.call(s, p)) t[p] = s[p];
        }
        return t;
      };
      return __assign2.apply(this, arguments);
    };
  }
});

// node_modules/tsyringe/dist/cjs/types/lifecycle.js
var require_lifecycle = __commonJS({
  "node_modules/tsyringe/dist/cjs/types/lifecycle.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    var Lifecycle;
    (function(Lifecycle2) {
      Lifecycle2[Lifecycle2["Transient"] = 0] = "Transient";
      Lifecycle2[Lifecycle2["Singleton"] = 1] = "Singleton";
      Lifecycle2[Lifecycle2["ResolutionScoped"] = 2] = "ResolutionScoped";
      Lifecycle2[Lifecycle2["ContainerScoped"] = 3] = "ContainerScoped";
    })(Lifecycle || (Lifecycle = {}));
    exports.default = Lifecycle;
  }
});

// node_modules/tsyringe/dist/cjs/types/index.js
var require_types4 = __commonJS({
  "node_modules/tsyringe/dist/cjs/types/index.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    var lifecycle_1 = require_lifecycle();
    Object.defineProperty(exports, "Lifecycle", { enumerable: true, get: function() {
      return lifecycle_1.default;
    } });
  }
});

// node_modules/tsyringe/dist/cjs/reflection-helpers.js
var require_reflection_helpers = __commonJS({
  "node_modules/tsyringe/dist/cjs/reflection-helpers.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.defineInjectionTokenMetadata = exports.getParamInfo = exports.INJECTION_TOKEN_METADATA_KEY = void 0;
    exports.INJECTION_TOKEN_METADATA_KEY = "injectionTokens";
    function getParamInfo(target) {
      const params = Reflect.getMetadata("design:paramtypes", target) || [];
      const injectionTokens = Reflect.getOwnMetadata(exports.INJECTION_TOKEN_METADATA_KEY, target) || {};
      Object.keys(injectionTokens).forEach((key) => {
        params[+key] = injectionTokens[key];
      });
      return params;
    }
    exports.getParamInfo = getParamInfo;
    function defineInjectionTokenMetadata(data, transform) {
      return function(target, _propertyKey, parameterIndex) {
        const descriptors = Reflect.getOwnMetadata(exports.INJECTION_TOKEN_METADATA_KEY, target) || {};
        descriptors[parameterIndex] = transform ? {
          token: data,
          transform: transform.transformToken,
          transformArgs: transform.args || []
        } : data;
        Reflect.defineMetadata(exports.INJECTION_TOKEN_METADATA_KEY, descriptors, target);
      };
    }
    exports.defineInjectionTokenMetadata = defineInjectionTokenMetadata;
  }
});

// node_modules/tsyringe/dist/cjs/providers/class-provider.js
var require_class_provider = __commonJS({
  "node_modules/tsyringe/dist/cjs/providers/class-provider.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.isClassProvider = void 0;
    function isClassProvider(provider) {
      return !!provider.useClass;
    }
    exports.isClassProvider = isClassProvider;
  }
});

// node_modules/tsyringe/dist/cjs/providers/factory-provider.js
var require_factory_provider = __commonJS({
  "node_modules/tsyringe/dist/cjs/providers/factory-provider.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.isFactoryProvider = void 0;
    function isFactoryProvider(provider) {
      return !!provider.useFactory;
    }
    exports.isFactoryProvider = isFactoryProvider;
  }
});

// node_modules/tsyringe/dist/cjs/lazy-helpers.js
var require_lazy_helpers = __commonJS({
  "node_modules/tsyringe/dist/cjs/lazy-helpers.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.delay = exports.DelayedConstructor = void 0;
    var DelayedConstructor = class {
      constructor(wrap) {
        this.wrap = wrap;
        this.reflectMethods = [
          "get",
          "getPrototypeOf",
          "setPrototypeOf",
          "getOwnPropertyDescriptor",
          "defineProperty",
          "has",
          "set",
          "deleteProperty",
          "apply",
          "construct",
          "ownKeys"
        ];
      }
      createProxy(createObject) {
        const target = {};
        let init = false;
        let value;
        const delayedObject = () => {
          if (!init) {
            value = createObject(this.wrap());
            init = true;
          }
          return value;
        };
        return new Proxy(target, this.createHandler(delayedObject));
      }
      createHandler(delayedObject) {
        const handler = {};
        const install = (name) => {
          handler[name] = (...args) => {
            args[0] = delayedObject();
            const method = Reflect[name];
            return method(...args);
          };
        };
        this.reflectMethods.forEach(install);
        return handler;
      }
    };
    exports.DelayedConstructor = DelayedConstructor;
    function delay(wrappedConstructor) {
      if (typeof wrappedConstructor === "undefined") {
        throw new Error("Attempt to `delay` undefined. Constructor must be wrapped in a callback");
      }
      return new DelayedConstructor(wrappedConstructor);
    }
    exports.delay = delay;
  }
});

// node_modules/tsyringe/dist/cjs/providers/injection-token.js
var require_injection_token = __commonJS({
  "node_modules/tsyringe/dist/cjs/providers/injection-token.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.isConstructorToken = exports.isTransformDescriptor = exports.isTokenDescriptor = exports.isNormalToken = void 0;
    var lazy_helpers_1 = require_lazy_helpers();
    function isNormalToken(token2) {
      return typeof token2 === "string" || typeof token2 === "symbol";
    }
    exports.isNormalToken = isNormalToken;
    function isTokenDescriptor(descriptor) {
      return typeof descriptor === "object" && "token" in descriptor && "multiple" in descriptor;
    }
    exports.isTokenDescriptor = isTokenDescriptor;
    function isTransformDescriptor(descriptor) {
      return typeof descriptor === "object" && "token" in descriptor && "transform" in descriptor;
    }
    exports.isTransformDescriptor = isTransformDescriptor;
    function isConstructorToken(token2) {
      return typeof token2 === "function" || token2 instanceof lazy_helpers_1.DelayedConstructor;
    }
    exports.isConstructorToken = isConstructorToken;
  }
});

// node_modules/tsyringe/dist/cjs/providers/token-provider.js
var require_token_provider = __commonJS({
  "node_modules/tsyringe/dist/cjs/providers/token-provider.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.isTokenProvider = void 0;
    function isTokenProvider(provider) {
      return !!provider.useToken;
    }
    exports.isTokenProvider = isTokenProvider;
  }
});

// node_modules/tsyringe/dist/cjs/providers/value-provider.js
var require_value_provider = __commonJS({
  "node_modules/tsyringe/dist/cjs/providers/value-provider.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.isValueProvider = void 0;
    function isValueProvider(provider) {
      return provider.useValue != void 0;
    }
    exports.isValueProvider = isValueProvider;
  }
});

// node_modules/tsyringe/dist/cjs/providers/index.js
var require_providers = __commonJS({
  "node_modules/tsyringe/dist/cjs/providers/index.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    var class_provider_1 = require_class_provider();
    Object.defineProperty(exports, "isClassProvider", { enumerable: true, get: function() {
      return class_provider_1.isClassProvider;
    } });
    var factory_provider_1 = require_factory_provider();
    Object.defineProperty(exports, "isFactoryProvider", { enumerable: true, get: function() {
      return factory_provider_1.isFactoryProvider;
    } });
    var injection_token_1 = require_injection_token();
    Object.defineProperty(exports, "isNormalToken", { enumerable: true, get: function() {
      return injection_token_1.isNormalToken;
    } });
    var token_provider_1 = require_token_provider();
    Object.defineProperty(exports, "isTokenProvider", { enumerable: true, get: function() {
      return token_provider_1.isTokenProvider;
    } });
    var value_provider_1 = require_value_provider();
    Object.defineProperty(exports, "isValueProvider", { enumerable: true, get: function() {
      return value_provider_1.isValueProvider;
    } });
  }
});

// node_modules/tsyringe/dist/cjs/providers/provider.js
var require_provider = __commonJS({
  "node_modules/tsyringe/dist/cjs/providers/provider.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.isProvider = void 0;
    var class_provider_1 = require_class_provider();
    var value_provider_1 = require_value_provider();
    var token_provider_1 = require_token_provider();
    var factory_provider_1 = require_factory_provider();
    function isProvider(provider) {
      return class_provider_1.isClassProvider(provider) || value_provider_1.isValueProvider(provider) || token_provider_1.isTokenProvider(provider) || factory_provider_1.isFactoryProvider(provider);
    }
    exports.isProvider = isProvider;
  }
});

// node_modules/tsyringe/dist/cjs/registry-base.js
var require_registry_base = __commonJS({
  "node_modules/tsyringe/dist/cjs/registry-base.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    var RegistryBase = class {
      constructor() {
        this._registryMap = /* @__PURE__ */ new Map();
      }
      entries() {
        return this._registryMap.entries();
      }
      getAll(key) {
        this.ensure(key);
        return this._registryMap.get(key);
      }
      get(key) {
        this.ensure(key);
        const value = this._registryMap.get(key);
        return value[value.length - 1] || null;
      }
      set(key, value) {
        this.ensure(key);
        this._registryMap.get(key).push(value);
      }
      setAll(key, value) {
        this._registryMap.set(key, value);
      }
      has(key) {
        this.ensure(key);
        return this._registryMap.get(key).length > 0;
      }
      clear() {
        this._registryMap.clear();
      }
      ensure(key) {
        if (!this._registryMap.has(key)) {
          this._registryMap.set(key, []);
        }
      }
    };
    exports.default = RegistryBase;
  }
});

// node_modules/tsyringe/dist/cjs/registry.js
var require_registry2 = __commonJS({
  "node_modules/tsyringe/dist/cjs/registry.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    var registry_base_1 = require_registry_base();
    var Registry = class extends registry_base_1.default {
    };
    exports.default = Registry;
  }
});

// node_modules/tsyringe/dist/cjs/resolution-context.js
var require_resolution_context = __commonJS({
  "node_modules/tsyringe/dist/cjs/resolution-context.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    var ResolutionContext = class {
      constructor() {
        this.scopedResolutions = /* @__PURE__ */ new Map();
      }
    };
    exports.default = ResolutionContext;
  }
});

// node_modules/tsyringe/dist/cjs/error-helpers.js
var require_error_helpers = __commonJS({
  "node_modules/tsyringe/dist/cjs/error-helpers.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.formatErrorCtor = void 0;
    function formatDependency(params, idx) {
      if (params === null) {
        return `at position #${idx}`;
      }
      const argName = params.split(",")[idx].trim();
      return `"${argName}" at position #${idx}`;
    }
    function composeErrorMessage(msg, e, indent = "    ") {
      return [msg, ...e.message.split("\n").map((l) => indent + l)].join("\n");
    }
    function formatErrorCtor(ctor, paramIdx, error) {
      const [, params = null] = ctor.toString().match(/constructor\(([\w, ]+)\)/) || [];
      const dep = formatDependency(params, paramIdx);
      return composeErrorMessage(`Cannot inject the dependency ${dep} of "${ctor.name}" constructor. Reason:`, error);
    }
    exports.formatErrorCtor = formatErrorCtor;
  }
});

// node_modules/tsyringe/dist/cjs/types/disposable.js
var require_disposable = __commonJS({
  "node_modules/tsyringe/dist/cjs/types/disposable.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.isDisposable = void 0;
    function isDisposable(value) {
      if (typeof value.dispose !== "function")
        return false;
      const disposeFun = value.dispose;
      if (disposeFun.length > 0) {
        return false;
      }
      return true;
    }
    exports.isDisposable = isDisposable;
  }
});

// node_modules/tsyringe/dist/cjs/interceptors.js
var require_interceptors = __commonJS({
  "node_modules/tsyringe/dist/cjs/interceptors.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.PostResolutionInterceptors = exports.PreResolutionInterceptors = void 0;
    var registry_base_1 = require_registry_base();
    var PreResolutionInterceptors = class extends registry_base_1.default {
    };
    exports.PreResolutionInterceptors = PreResolutionInterceptors;
    var PostResolutionInterceptors = class extends registry_base_1.default {
    };
    exports.PostResolutionInterceptors = PostResolutionInterceptors;
    var Interceptors = class {
      constructor() {
        this.preResolution = new PreResolutionInterceptors();
        this.postResolution = new PostResolutionInterceptors();
      }
    };
    exports.default = Interceptors;
  }
});

// node_modules/tsyringe/dist/cjs/dependency-container.js
var require_dependency_container = __commonJS({
  "node_modules/tsyringe/dist/cjs/dependency-container.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.instance = exports.typeInfo = void 0;
    var tslib_1 = (init_tslib_es62(), __toCommonJS(tslib_es6_exports2));
    var providers_1 = require_providers();
    var provider_1 = require_provider();
    var injection_token_1 = require_injection_token();
    var registry_1 = require_registry2();
    var lifecycle_1 = require_lifecycle();
    var resolution_context_1 = require_resolution_context();
    var error_helpers_1 = require_error_helpers();
    var lazy_helpers_1 = require_lazy_helpers();
    var disposable_1 = require_disposable();
    var interceptors_1 = require_interceptors();
    exports.typeInfo = /* @__PURE__ */ new Map();
    var InternalDependencyContainer = class _InternalDependencyContainer {
      constructor(parent) {
        this.parent = parent;
        this._registry = new registry_1.default();
        this.interceptors = new interceptors_1.default();
        this.disposed = false;
        this.disposables = /* @__PURE__ */ new Set();
      }
      register(token2, providerOrConstructor, options = { lifecycle: lifecycle_1.default.Transient }) {
        this.ensureNotDisposed();
        let provider;
        if (!provider_1.isProvider(providerOrConstructor)) {
          provider = { useClass: providerOrConstructor };
        } else {
          provider = providerOrConstructor;
        }
        if (providers_1.isTokenProvider(provider)) {
          const path = [token2];
          let tokenProvider = provider;
          while (tokenProvider != null) {
            const currentToken = tokenProvider.useToken;
            if (path.includes(currentToken)) {
              throw new Error(`Token registration cycle detected! ${[...path, currentToken].join(" -> ")}`);
            }
            path.push(currentToken);
            const registration = this._registry.get(currentToken);
            if (registration && providers_1.isTokenProvider(registration.provider)) {
              tokenProvider = registration.provider;
            } else {
              tokenProvider = null;
            }
          }
        }
        if (options.lifecycle === lifecycle_1.default.Singleton || options.lifecycle == lifecycle_1.default.ContainerScoped || options.lifecycle == lifecycle_1.default.ResolutionScoped) {
          if (providers_1.isValueProvider(provider) || providers_1.isFactoryProvider(provider)) {
            throw new Error(`Cannot use lifecycle "${lifecycle_1.default[options.lifecycle]}" with ValueProviders or FactoryProviders`);
          }
        }
        this._registry.set(token2, { provider, options });
        return this;
      }
      registerType(from, to) {
        this.ensureNotDisposed();
        if (providers_1.isNormalToken(to)) {
          return this.register(from, {
            useToken: to
          });
        }
        return this.register(from, {
          useClass: to
        });
      }
      registerInstance(token2, instance) {
        this.ensureNotDisposed();
        return this.register(token2, {
          useValue: instance
        });
      }
      registerSingleton(from, to) {
        this.ensureNotDisposed();
        if (providers_1.isNormalToken(from)) {
          if (providers_1.isNormalToken(to)) {
            return this.register(from, {
              useToken: to
            }, { lifecycle: lifecycle_1.default.Singleton });
          } else if (to) {
            return this.register(from, {
              useClass: to
            }, { lifecycle: lifecycle_1.default.Singleton });
          }
          throw new Error('Cannot register a type name as a singleton without a "to" token');
        }
        let useClass = from;
        if (to && !providers_1.isNormalToken(to)) {
          useClass = to;
        }
        return this.register(from, {
          useClass
        }, { lifecycle: lifecycle_1.default.Singleton });
      }
      resolve(token2, context = new resolution_context_1.default(), isOptional = false) {
        this.ensureNotDisposed();
        const registration = this.getRegistration(token2);
        if (!registration && providers_1.isNormalToken(token2)) {
          if (isOptional) {
            return void 0;
          }
          throw new Error(`Attempted to resolve unregistered dependency token: "${token2.toString()}"`);
        }
        this.executePreResolutionInterceptor(token2, "Single");
        if (registration) {
          const result = this.resolveRegistration(registration, context);
          this.executePostResolutionInterceptor(token2, result, "Single");
          return result;
        }
        if (injection_token_1.isConstructorToken(token2)) {
          const result = this.construct(token2, context);
          this.executePostResolutionInterceptor(token2, result, "Single");
          return result;
        }
        throw new Error("Attempted to construct an undefined constructor. Could mean a circular dependency problem. Try using `delay` function.");
      }
      executePreResolutionInterceptor(token2, resolutionType) {
        if (this.interceptors.preResolution.has(token2)) {
          const remainingInterceptors = [];
          for (const interceptor of this.interceptors.preResolution.getAll(token2)) {
            if (interceptor.options.frequency != "Once") {
              remainingInterceptors.push(interceptor);
            }
            interceptor.callback(token2, resolutionType);
          }
          this.interceptors.preResolution.setAll(token2, remainingInterceptors);
        }
      }
      executePostResolutionInterceptor(token2, result, resolutionType) {
        if (this.interceptors.postResolution.has(token2)) {
          const remainingInterceptors = [];
          for (const interceptor of this.interceptors.postResolution.getAll(token2)) {
            if (interceptor.options.frequency != "Once") {
              remainingInterceptors.push(interceptor);
            }
            interceptor.callback(token2, result, resolutionType);
          }
          this.interceptors.postResolution.setAll(token2, remainingInterceptors);
        }
      }
      resolveRegistration(registration, context) {
        this.ensureNotDisposed();
        if (registration.options.lifecycle === lifecycle_1.default.ResolutionScoped && context.scopedResolutions.has(registration)) {
          return context.scopedResolutions.get(registration);
        }
        const isSingleton = registration.options.lifecycle === lifecycle_1.default.Singleton;
        const isContainerScoped = registration.options.lifecycle === lifecycle_1.default.ContainerScoped;
        const returnInstance = isSingleton || isContainerScoped;
        let resolved;
        if (providers_1.isValueProvider(registration.provider)) {
          resolved = registration.provider.useValue;
        } else if (providers_1.isTokenProvider(registration.provider)) {
          resolved = returnInstance ? registration.instance || (registration.instance = this.resolve(registration.provider.useToken, context)) : this.resolve(registration.provider.useToken, context);
        } else if (providers_1.isClassProvider(registration.provider)) {
          resolved = returnInstance ? registration.instance || (registration.instance = this.construct(registration.provider.useClass, context)) : this.construct(registration.provider.useClass, context);
        } else if (providers_1.isFactoryProvider(registration.provider)) {
          resolved = registration.provider.useFactory(this);
        } else {
          resolved = this.construct(registration.provider, context);
        }
        if (registration.options.lifecycle === lifecycle_1.default.ResolutionScoped) {
          context.scopedResolutions.set(registration, resolved);
        }
        return resolved;
      }
      resolveAll(token2, context = new resolution_context_1.default(), isOptional = false) {
        this.ensureNotDisposed();
        const registrations = this.getAllRegistrations(token2);
        if (!registrations && providers_1.isNormalToken(token2)) {
          if (isOptional) {
            return [];
          }
          throw new Error(`Attempted to resolve unregistered dependency token: "${token2.toString()}"`);
        }
        this.executePreResolutionInterceptor(token2, "All");
        if (registrations) {
          const result2 = registrations.map((item) => this.resolveRegistration(item, context));
          this.executePostResolutionInterceptor(token2, result2, "All");
          return result2;
        }
        const result = [this.construct(token2, context)];
        this.executePostResolutionInterceptor(token2, result, "All");
        return result;
      }
      isRegistered(token2, recursive = false) {
        this.ensureNotDisposed();
        return this._registry.has(token2) || recursive && (this.parent || false) && this.parent.isRegistered(token2, true);
      }
      reset() {
        this.ensureNotDisposed();
        this._registry.clear();
        this.interceptors.preResolution.clear();
        this.interceptors.postResolution.clear();
      }
      clearInstances() {
        this.ensureNotDisposed();
        for (const [token2, registrations] of this._registry.entries()) {
          this._registry.setAll(token2, registrations.filter((registration) => !providers_1.isValueProvider(registration.provider)).map((registration) => {
            registration.instance = void 0;
            return registration;
          }));
        }
      }
      createChildContainer() {
        this.ensureNotDisposed();
        const childContainer = new _InternalDependencyContainer(this);
        for (const [token2, registrations] of this._registry.entries()) {
          if (registrations.some(({ options }) => options.lifecycle === lifecycle_1.default.ContainerScoped)) {
            childContainer._registry.setAll(token2, registrations.map((registration) => {
              if (registration.options.lifecycle === lifecycle_1.default.ContainerScoped) {
                return {
                  provider: registration.provider,
                  options: registration.options
                };
              }
              return registration;
            }));
          }
        }
        return childContainer;
      }
      beforeResolution(token2, callback, options = { frequency: "Always" }) {
        this.interceptors.preResolution.set(token2, {
          callback,
          options
        });
      }
      afterResolution(token2, callback, options = { frequency: "Always" }) {
        this.interceptors.postResolution.set(token2, {
          callback,
          options
        });
      }
      dispose() {
        return tslib_1.__awaiter(this, void 0, void 0, function* () {
          this.disposed = true;
          const promises = [];
          this.disposables.forEach((disposable) => {
            const maybePromise = disposable.dispose();
            if (maybePromise) {
              promises.push(maybePromise);
            }
          });
          yield Promise.all(promises);
        });
      }
      getRegistration(token2) {
        if (this.isRegistered(token2)) {
          return this._registry.get(token2);
        }
        if (this.parent) {
          return this.parent.getRegistration(token2);
        }
        return null;
      }
      getAllRegistrations(token2) {
        if (this.isRegistered(token2)) {
          return this._registry.getAll(token2);
        }
        if (this.parent) {
          return this.parent.getAllRegistrations(token2);
        }
        return null;
      }
      construct(ctor, context) {
        if (ctor instanceof lazy_helpers_1.DelayedConstructor) {
          return ctor.createProxy((target) => this.resolve(target, context));
        }
        const instance = (() => {
          const paramInfo = exports.typeInfo.get(ctor);
          if (!paramInfo || paramInfo.length === 0) {
            if (ctor.length === 0) {
              return new ctor();
            } else {
              throw new Error(`TypeInfo not known for "${ctor.name}"`);
            }
          }
          const params = paramInfo.map(this.resolveParams(context, ctor));
          return new ctor(...params);
        })();
        if (disposable_1.isDisposable(instance)) {
          this.disposables.add(instance);
        }
        return instance;
      }
      resolveParams(context, ctor) {
        return (param, idx) => {
          try {
            if (injection_token_1.isTokenDescriptor(param)) {
              if (injection_token_1.isTransformDescriptor(param)) {
                return param.multiple ? this.resolve(param.transform).transform(this.resolveAll(param.token, new resolution_context_1.default(), param.isOptional), ...param.transformArgs) : this.resolve(param.transform).transform(this.resolve(param.token, context, param.isOptional), ...param.transformArgs);
              } else {
                return param.multiple ? this.resolveAll(param.token, new resolution_context_1.default(), param.isOptional) : this.resolve(param.token, context, param.isOptional);
              }
            } else if (injection_token_1.isTransformDescriptor(param)) {
              return this.resolve(param.transform, context).transform(this.resolve(param.token, context), ...param.transformArgs);
            }
            return this.resolve(param, context);
          } catch (e) {
            throw new Error(error_helpers_1.formatErrorCtor(ctor, idx, e));
          }
        };
      }
      ensureNotDisposed() {
        if (this.disposed) {
          throw new Error("This container has been disposed, you cannot interact with a disposed container");
        }
      }
    };
    exports.instance = new InternalDependencyContainer();
    exports.default = exports.instance;
  }
});

// node_modules/tsyringe/dist/cjs/decorators/auto-injectable.js
var require_auto_injectable = __commonJS({
  "node_modules/tsyringe/dist/cjs/decorators/auto-injectable.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    var reflection_helpers_1 = require_reflection_helpers();
    var dependency_container_1 = require_dependency_container();
    var injection_token_1 = require_injection_token();
    var error_helpers_1 = require_error_helpers();
    function autoInjectable() {
      return function(target) {
        const paramInfo = reflection_helpers_1.getParamInfo(target);
        return class extends target {
          constructor(...args) {
            super(...args.concat(paramInfo.slice(args.length).map((type, index) => {
              try {
                if (injection_token_1.isTokenDescriptor(type)) {
                  if (injection_token_1.isTransformDescriptor(type)) {
                    return type.multiple ? dependency_container_1.instance.resolve(type.transform).transform(dependency_container_1.instance.resolveAll(type.token), ...type.transformArgs) : dependency_container_1.instance.resolve(type.transform).transform(dependency_container_1.instance.resolve(type.token), ...type.transformArgs);
                  } else {
                    return type.multiple ? dependency_container_1.instance.resolveAll(type.token) : dependency_container_1.instance.resolve(type.token);
                  }
                } else if (injection_token_1.isTransformDescriptor(type)) {
                  return dependency_container_1.instance.resolve(type.transform).transform(dependency_container_1.instance.resolve(type.token), ...type.transformArgs);
                }
                return dependency_container_1.instance.resolve(type);
              } catch (e) {
                const argIndex = index + args.length;
                throw new Error(error_helpers_1.formatErrorCtor(target, argIndex, e));
              }
            })));
          }
        };
      };
    }
    exports.default = autoInjectable;
  }
});

// node_modules/tsyringe/dist/cjs/decorators/inject.js
var require_inject = __commonJS({
  "node_modules/tsyringe/dist/cjs/decorators/inject.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    var reflection_helpers_1 = require_reflection_helpers();
    function inject(token2, options) {
      const data = {
        token: token2,
        multiple: false,
        isOptional: options && options.isOptional
      };
      return reflection_helpers_1.defineInjectionTokenMetadata(data);
    }
    exports.default = inject;
  }
});

// node_modules/tsyringe/dist/cjs/decorators/injectable.js
var require_injectable = __commonJS({
  "node_modules/tsyringe/dist/cjs/decorators/injectable.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    var reflection_helpers_1 = require_reflection_helpers();
    var dependency_container_1 = require_dependency_container();
    var dependency_container_2 = require_dependency_container();
    function injectable(options) {
      return function(target) {
        dependency_container_1.typeInfo.set(target, reflection_helpers_1.getParamInfo(target));
        if (options && options.token) {
          if (!Array.isArray(options.token)) {
            dependency_container_2.instance.register(options.token, target);
          } else {
            options.token.forEach((token2) => {
              dependency_container_2.instance.register(token2, target);
            });
          }
        }
      };
    }
    exports.default = injectable;
  }
});

// node_modules/tsyringe/dist/cjs/decorators/registry.js
var require_registry3 = __commonJS({
  "node_modules/tsyringe/dist/cjs/decorators/registry.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    var tslib_1 = (init_tslib_es62(), __toCommonJS(tslib_es6_exports2));
    var dependency_container_1 = require_dependency_container();
    function registry(registrations = []) {
      return function(target) {
        registrations.forEach((_a) => {
          var { token: token2, options } = _a, provider = tslib_1.__rest(_a, ["token", "options"]);
          return dependency_container_1.instance.register(token2, provider, options);
        });
        return target;
      };
    }
    exports.default = registry;
  }
});

// node_modules/tsyringe/dist/cjs/decorators/singleton.js
var require_singleton = __commonJS({
  "node_modules/tsyringe/dist/cjs/decorators/singleton.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    var injectable_1 = require_injectable();
    var dependency_container_1 = require_dependency_container();
    function singleton() {
      return function(target) {
        injectable_1.default()(target);
        dependency_container_1.instance.registerSingleton(target);
      };
    }
    exports.default = singleton;
  }
});

// node_modules/tsyringe/dist/cjs/decorators/inject-all.js
var require_inject_all = __commonJS({
  "node_modules/tsyringe/dist/cjs/decorators/inject-all.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    var reflection_helpers_1 = require_reflection_helpers();
    function injectAll(token2, options) {
      const data = {
        token: token2,
        multiple: true,
        isOptional: options && options.isOptional
      };
      return reflection_helpers_1.defineInjectionTokenMetadata(data);
    }
    exports.default = injectAll;
  }
});

// node_modules/tsyringe/dist/cjs/decorators/inject-all-with-transform.js
var require_inject_all_with_transform = __commonJS({
  "node_modules/tsyringe/dist/cjs/decorators/inject-all-with-transform.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    var reflection_helpers_1 = require_reflection_helpers();
    function injectAllWithTransform(token2, transformer, ...args) {
      const data = {
        token: token2,
        multiple: true,
        transform: transformer,
        transformArgs: args
      };
      return reflection_helpers_1.defineInjectionTokenMetadata(data);
    }
    exports.default = injectAllWithTransform;
  }
});

// node_modules/tsyringe/dist/cjs/decorators/inject-with-transform.js
var require_inject_with_transform = __commonJS({
  "node_modules/tsyringe/dist/cjs/decorators/inject-with-transform.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    var reflection_helpers_1 = require_reflection_helpers();
    function injectWithTransform(token2, transformer, ...args) {
      return reflection_helpers_1.defineInjectionTokenMetadata(token2, {
        transformToken: transformer,
        args
      });
    }
    exports.default = injectWithTransform;
  }
});

// node_modules/tsyringe/dist/cjs/decorators/scoped.js
var require_scoped = __commonJS({
  "node_modules/tsyringe/dist/cjs/decorators/scoped.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    var injectable_1 = require_injectable();
    var dependency_container_1 = require_dependency_container();
    function scoped(lifecycle, token2) {
      return function(target) {
        injectable_1.default()(target);
        dependency_container_1.instance.register(token2 || target, target, {
          lifecycle
        });
      };
    }
    exports.default = scoped;
  }
});

// node_modules/tsyringe/dist/cjs/decorators/index.js
var require_decorators2 = __commonJS({
  "node_modules/tsyringe/dist/cjs/decorators/index.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    var auto_injectable_1 = require_auto_injectable();
    Object.defineProperty(exports, "autoInjectable", { enumerable: true, get: function() {
      return auto_injectable_1.default;
    } });
    var inject_1 = require_inject();
    Object.defineProperty(exports, "inject", { enumerable: true, get: function() {
      return inject_1.default;
    } });
    var injectable_1 = require_injectable();
    Object.defineProperty(exports, "injectable", { enumerable: true, get: function() {
      return injectable_1.default;
    } });
    var registry_1 = require_registry3();
    Object.defineProperty(exports, "registry", { enumerable: true, get: function() {
      return registry_1.default;
    } });
    var singleton_1 = require_singleton();
    Object.defineProperty(exports, "singleton", { enumerable: true, get: function() {
      return singleton_1.default;
    } });
    var inject_all_1 = require_inject_all();
    Object.defineProperty(exports, "injectAll", { enumerable: true, get: function() {
      return inject_all_1.default;
    } });
    var inject_all_with_transform_1 = require_inject_all_with_transform();
    Object.defineProperty(exports, "injectAllWithTransform", { enumerable: true, get: function() {
      return inject_all_with_transform_1.default;
    } });
    var inject_with_transform_1 = require_inject_with_transform();
    Object.defineProperty(exports, "injectWithTransform", { enumerable: true, get: function() {
      return inject_with_transform_1.default;
    } });
    var scoped_1 = require_scoped();
    Object.defineProperty(exports, "scoped", { enumerable: true, get: function() {
      return scoped_1.default;
    } });
  }
});

// node_modules/tsyringe/dist/cjs/factories/instance-caching-factory.js
var require_instance_caching_factory = __commonJS({
  "node_modules/tsyringe/dist/cjs/factories/instance-caching-factory.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    function instanceCachingFactory(factoryFunc) {
      let instance;
      return (dependencyContainer) => {
        if (instance == void 0) {
          instance = factoryFunc(dependencyContainer);
        }
        return instance;
      };
    }
    exports.default = instanceCachingFactory;
  }
});

// node_modules/tsyringe/dist/cjs/factories/instance-per-container-caching-factory.js
var require_instance_per_container_caching_factory = __commonJS({
  "node_modules/tsyringe/dist/cjs/factories/instance-per-container-caching-factory.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    function instancePerContainerCachingFactory(factoryFunc) {
      const cache = /* @__PURE__ */ new WeakMap();
      return (dependencyContainer) => {
        let instance = cache.get(dependencyContainer);
        if (instance == void 0) {
          instance = factoryFunc(dependencyContainer);
          cache.set(dependencyContainer, instance);
        }
        return instance;
      };
    }
    exports.default = instancePerContainerCachingFactory;
  }
});

// node_modules/tsyringe/dist/cjs/factories/predicate-aware-class-factory.js
var require_predicate_aware_class_factory = __commonJS({
  "node_modules/tsyringe/dist/cjs/factories/predicate-aware-class-factory.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    function predicateAwareClassFactory(predicate, trueConstructor, falseConstructor, useCaching = true) {
      let instance;
      let previousPredicate;
      return (dependencyContainer) => {
        const currentPredicate = predicate(dependencyContainer);
        if (!useCaching || previousPredicate !== currentPredicate) {
          if (previousPredicate = currentPredicate) {
            instance = dependencyContainer.resolve(trueConstructor);
          } else {
            instance = dependencyContainer.resolve(falseConstructor);
          }
        }
        return instance;
      };
    }
    exports.default = predicateAwareClassFactory;
  }
});

// node_modules/tsyringe/dist/cjs/factories/index.js
var require_factories = __commonJS({
  "node_modules/tsyringe/dist/cjs/factories/index.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    var instance_caching_factory_1 = require_instance_caching_factory();
    Object.defineProperty(exports, "instanceCachingFactory", { enumerable: true, get: function() {
      return instance_caching_factory_1.default;
    } });
    var instance_per_container_caching_factory_1 = require_instance_per_container_caching_factory();
    Object.defineProperty(exports, "instancePerContainerCachingFactory", { enumerable: true, get: function() {
      return instance_per_container_caching_factory_1.default;
    } });
    var predicate_aware_class_factory_1 = require_predicate_aware_class_factory();
    Object.defineProperty(exports, "predicateAwareClassFactory", { enumerable: true, get: function() {
      return predicate_aware_class_factory_1.default;
    } });
  }
});

// node_modules/tsyringe/dist/cjs/index.js
var require_cjs8 = __commonJS({
  "node_modules/tsyringe/dist/cjs/index.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    var tslib_1 = (init_tslib_es62(), __toCommonJS(tslib_es6_exports2));
    if (typeof Reflect === "undefined" || !Reflect.getMetadata) {
      throw new Error(`tsyringe requires a reflect polyfill. Please add 'import "reflect-metadata"' to the top of your entry point.`);
    }
    var types_1 = require_types4();
    Object.defineProperty(exports, "Lifecycle", { enumerable: true, get: function() {
      return types_1.Lifecycle;
    } });
    tslib_1.__exportStar(require_decorators2(), exports);
    tslib_1.__exportStar(require_factories(), exports);
    tslib_1.__exportStar(require_providers(), exports);
    var lazy_helpers_1 = require_lazy_helpers();
    Object.defineProperty(exports, "delay", { enumerable: true, get: function() {
      return lazy_helpers_1.delay;
    } });
    var dependency_container_1 = require_dependency_container();
    Object.defineProperty(exports, "container", { enumerable: true, get: function() {
      return dependency_container_1.instance;
    } });
  }
});

// node_modules/@peculiar/asn1-pfx/build/cjs/attribute.js
var require_attribute3 = __commonJS({
  "node_modules/@peculiar/asn1-pfx/build/cjs/attribute.js"(exports) {
    "use strict";
    var PKCS12AttrSet_1;
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.PKCS12AttrSet = exports.PKCS12Attribute = void 0;
    var tslib_1 = (init_tslib_es6(), __toCommonJS(tslib_es6_exports));
    var asn1_schema_1 = require_cjs2();
    var PKCS12Attribute = class {
      attrId = "";
      attrValues = [];
      constructor(params = {}) {
        Object.assign(params);
      }
    };
    exports.PKCS12Attribute = PKCS12Attribute;
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({ type: asn1_schema_1.AsnPropTypes.ObjectIdentifier })
    ], PKCS12Attribute.prototype, "attrId", void 0);
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({
        type: asn1_schema_1.AsnPropTypes.Any,
        repeated: "set"
      })
    ], PKCS12Attribute.prototype, "attrValues", void 0);
    var PKCS12AttrSet = PKCS12AttrSet_1 = class PKCS12AttrSet extends asn1_schema_1.AsnArray {
      constructor(items) {
        super(items);
        Object.setPrototypeOf(this, PKCS12AttrSet_1.prototype);
      }
    };
    exports.PKCS12AttrSet = PKCS12AttrSet;
    exports.PKCS12AttrSet = PKCS12AttrSet = PKCS12AttrSet_1 = tslib_1.__decorate([
      (0, asn1_schema_1.AsnType)({
        type: asn1_schema_1.AsnTypeTypes.Sequence,
        itemType: PKCS12Attribute
      })
    ], PKCS12AttrSet);
  }
});

// node_modules/@peculiar/asn1-pfx/build/cjs/authenticated_safe.js
var require_authenticated_safe = __commonJS({
  "node_modules/@peculiar/asn1-pfx/build/cjs/authenticated_safe.js"(exports) {
    "use strict";
    var AuthenticatedSafe_1;
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.AuthenticatedSafe = void 0;
    var tslib_1 = (init_tslib_es6(), __toCommonJS(tslib_es6_exports));
    var asn1_schema_1 = require_cjs2();
    var asn1_cms_1 = require_cjs5();
    var AuthenticatedSafe = AuthenticatedSafe_1 = class AuthenticatedSafe extends asn1_schema_1.AsnArray {
      constructor(items) {
        super(items);
        Object.setPrototypeOf(this, AuthenticatedSafe_1.prototype);
      }
    };
    exports.AuthenticatedSafe = AuthenticatedSafe;
    exports.AuthenticatedSafe = AuthenticatedSafe = AuthenticatedSafe_1 = tslib_1.__decorate([
      (0, asn1_schema_1.AsnType)({
        type: asn1_schema_1.AsnTypeTypes.Sequence,
        itemType: asn1_cms_1.ContentInfo
      })
    ], AuthenticatedSafe);
  }
});

// node_modules/@peculiar/asn1-pfx/build/cjs/object_identifiers.js
var require_object_identifiers6 = __commonJS({
  "node_modules/@peculiar/asn1-pfx/build/cjs/object_identifiers.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.id_bagtypes = exports.id_pbewithSHAAnd40BitRC2_CBC = exports.id_pbeWithSHAAnd128BitRC2_CBC = exports.id_pbeWithSHAAnd2_KeyTripleDES_CBC = exports.id_pbeWithSHAAnd3_KeyTripleDES_CBC = exports.id_pbeWithSHAAnd40BitRC4 = exports.id_pbeWithSHAAnd128BitRC4 = exports.id_pkcs_12PbeIds = exports.id_pkcs_12 = exports.id_pkcs = exports.id_rsadsi = void 0;
    exports.id_rsadsi = "1.2.840.113549";
    exports.id_pkcs = `${exports.id_rsadsi}.1`;
    exports.id_pkcs_12 = `${exports.id_pkcs}.12`;
    exports.id_pkcs_12PbeIds = `${exports.id_pkcs_12}.1`;
    exports.id_pbeWithSHAAnd128BitRC4 = `${exports.id_pkcs_12PbeIds}.1`;
    exports.id_pbeWithSHAAnd40BitRC4 = `${exports.id_pkcs_12PbeIds}.2`;
    exports.id_pbeWithSHAAnd3_KeyTripleDES_CBC = `${exports.id_pkcs_12PbeIds}.3`;
    exports.id_pbeWithSHAAnd2_KeyTripleDES_CBC = `${exports.id_pkcs_12PbeIds}.4`;
    exports.id_pbeWithSHAAnd128BitRC2_CBC = `${exports.id_pkcs_12PbeIds}.5`;
    exports.id_pbewithSHAAnd40BitRC2_CBC = `${exports.id_pkcs_12PbeIds}.6`;
    exports.id_bagtypes = `${exports.id_pkcs_12}.10.1`;
  }
});

// node_modules/@peculiar/asn1-pfx/build/cjs/bags/types.js
var require_types5 = __commonJS({
  "node_modules/@peculiar/asn1-pfx/build/cjs/bags/types.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.id_pkcs_9 = exports.id_SafeContents = exports.id_SecretBag = exports.id_CRLBag = exports.id_certBag = exports.id_pkcs8ShroudedKeyBag = exports.id_keyBag = void 0;
    var object_identifiers_1 = require_object_identifiers6();
    exports.id_keyBag = `${object_identifiers_1.id_bagtypes}.1`;
    exports.id_pkcs8ShroudedKeyBag = `${object_identifiers_1.id_bagtypes}.2`;
    exports.id_certBag = `${object_identifiers_1.id_bagtypes}.3`;
    exports.id_CRLBag = `${object_identifiers_1.id_bagtypes}.4`;
    exports.id_SecretBag = `${object_identifiers_1.id_bagtypes}.5`;
    exports.id_SafeContents = `${object_identifiers_1.id_bagtypes}.6`;
    exports.id_pkcs_9 = "1.2.840.113549.1.9";
  }
});

// node_modules/@peculiar/asn1-pfx/build/cjs/bags/cert_bag.js
var require_cert_bag = __commonJS({
  "node_modules/@peculiar/asn1-pfx/build/cjs/bags/cert_bag.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.id_sdsiCertificate = exports.id_x509Certificate = exports.id_certTypes = exports.CertBag = void 0;
    var tslib_1 = (init_tslib_es6(), __toCommonJS(tslib_es6_exports));
    var asn1_schema_1 = require_cjs2();
    var types_1 = require_types5();
    var CertBag = class {
      certId = "";
      certValue = new ArrayBuffer(0);
      constructor(params = {}) {
        Object.assign(this, params);
      }
    };
    exports.CertBag = CertBag;
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({ type: asn1_schema_1.AsnPropTypes.ObjectIdentifier })
    ], CertBag.prototype, "certId", void 0);
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({
        type: asn1_schema_1.AsnPropTypes.Any,
        context: 0
      })
    ], CertBag.prototype, "certValue", void 0);
    exports.id_certTypes = `${types_1.id_pkcs_9}.22`;
    exports.id_x509Certificate = `${exports.id_certTypes}.1`;
    exports.id_sdsiCertificate = `${exports.id_certTypes}.2`;
  }
});

// node_modules/@peculiar/asn1-pfx/build/cjs/bags/crl_bag.js
var require_crl_bag = __commonJS({
  "node_modules/@peculiar/asn1-pfx/build/cjs/bags/crl_bag.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.id_x509CRL = exports.id_crlTypes = exports.CRLBag = void 0;
    var tslib_1 = (init_tslib_es6(), __toCommonJS(tslib_es6_exports));
    var asn1_schema_1 = require_cjs2();
    var types_1 = require_types5();
    var CRLBag = class {
      crlId = "";
      crltValue = new ArrayBuffer(0);
      constructor(params = {}) {
        Object.assign(this, params);
      }
    };
    exports.CRLBag = CRLBag;
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({ type: asn1_schema_1.AsnPropTypes.ObjectIdentifier })
    ], CRLBag.prototype, "crlId", void 0);
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({
        type: asn1_schema_1.AsnPropTypes.Any,
        context: 0
      })
    ], CRLBag.prototype, "crltValue", void 0);
    exports.id_crlTypes = `${types_1.id_pkcs_9}.23`;
    exports.id_x509CRL = `${exports.id_crlTypes}.1`;
  }
});

// node_modules/@peculiar/asn1-pkcs8/build/cjs/encrypted_private_key_info.js
var require_encrypted_private_key_info = __commonJS({
  "node_modules/@peculiar/asn1-pkcs8/build/cjs/encrypted_private_key_info.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.EncryptedPrivateKeyInfo = exports.EncryptedData = void 0;
    var tslib_1 = (init_tslib_es6(), __toCommonJS(tslib_es6_exports));
    var asn1_schema_1 = require_cjs2();
    var asn1_x509_1 = require_cjs3();
    var EncryptedData = class extends asn1_schema_1.OctetString {
    };
    exports.EncryptedData = EncryptedData;
    var EncryptedPrivateKeyInfo = class {
      encryptionAlgorithm = new asn1_x509_1.AlgorithmIdentifier();
      encryptedData = new EncryptedData();
      constructor(params = {}) {
        Object.assign(this, params);
      }
    };
    exports.EncryptedPrivateKeyInfo = EncryptedPrivateKeyInfo;
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({ type: asn1_x509_1.AlgorithmIdentifier })
    ], EncryptedPrivateKeyInfo.prototype, "encryptionAlgorithm", void 0);
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({ type: EncryptedData })
    ], EncryptedPrivateKeyInfo.prototype, "encryptedData", void 0);
  }
});

// node_modules/@peculiar/asn1-pkcs8/build/cjs/private_key_info.js
var require_private_key_info = __commonJS({
  "node_modules/@peculiar/asn1-pkcs8/build/cjs/private_key_info.js"(exports) {
    "use strict";
    var Attributes_1;
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.PrivateKeyInfo = exports.Attributes = exports.PrivateKey = exports.Version = void 0;
    var tslib_1 = (init_tslib_es6(), __toCommonJS(tslib_es6_exports));
    var asn1_schema_1 = require_cjs2();
    var asn1_x509_1 = require_cjs3();
    var Version;
    (function(Version2) {
      Version2[Version2["v1"] = 0] = "v1";
    })(Version || (exports.Version = Version = {}));
    var PrivateKey = class extends asn1_schema_1.OctetString {
    };
    exports.PrivateKey = PrivateKey;
    var Attributes = Attributes_1 = class Attributes extends asn1_schema_1.AsnArray {
      constructor(items) {
        super(items);
        Object.setPrototypeOf(this, Attributes_1.prototype);
      }
    };
    exports.Attributes = Attributes;
    exports.Attributes = Attributes = Attributes_1 = tslib_1.__decorate([
      (0, asn1_schema_1.AsnType)({
        type: asn1_schema_1.AsnTypeTypes.Sequence,
        itemType: asn1_x509_1.Attribute
      })
    ], Attributes);
    var PrivateKeyInfo = class {
      version = Version.v1;
      privateKeyAlgorithm = new asn1_x509_1.AlgorithmIdentifier();
      privateKey = new PrivateKey();
      attributes;
      constructor(params = {}) {
        Object.assign(this, params);
      }
    };
    exports.PrivateKeyInfo = PrivateKeyInfo;
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({ type: asn1_schema_1.AsnPropTypes.Integer })
    ], PrivateKeyInfo.prototype, "version", void 0);
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({ type: asn1_x509_1.AlgorithmIdentifier })
    ], PrivateKeyInfo.prototype, "privateKeyAlgorithm", void 0);
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({ type: PrivateKey })
    ], PrivateKeyInfo.prototype, "privateKey", void 0);
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({
        type: Attributes,
        implicit: true,
        context: 0,
        optional: true
      })
    ], PrivateKeyInfo.prototype, "attributes", void 0);
  }
});

// node_modules/@peculiar/asn1-pkcs8/build/cjs/index.js
var require_cjs9 = __commonJS({
  "node_modules/@peculiar/asn1-pkcs8/build/cjs/index.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    var tslib_1 = (init_tslib_es6(), __toCommonJS(tslib_es6_exports));
    tslib_1.__exportStar(require_encrypted_private_key_info(), exports);
    tslib_1.__exportStar(require_private_key_info(), exports);
  }
});

// node_modules/@peculiar/asn1-pfx/build/cjs/bags/key_bag.js
var require_key_bag = __commonJS({
  "node_modules/@peculiar/asn1-pfx/build/cjs/bags/key_bag.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.KeyBag = void 0;
    var tslib_1 = (init_tslib_es6(), __toCommonJS(tslib_es6_exports));
    var asn1_pkcs8_1 = require_cjs9();
    var asn1_schema_1 = require_cjs2();
    var KeyBag = class KeyBag extends asn1_pkcs8_1.PrivateKeyInfo {
    };
    exports.KeyBag = KeyBag;
    exports.KeyBag = KeyBag = tslib_1.__decorate([
      (0, asn1_schema_1.AsnType)({ type: asn1_schema_1.AsnTypeTypes.Sequence })
    ], KeyBag);
  }
});

// node_modules/@peculiar/asn1-pfx/build/cjs/bags/pkcs8_shrouded_key_bag.js
var require_pkcs8_shrouded_key_bag = __commonJS({
  "node_modules/@peculiar/asn1-pfx/build/cjs/bags/pkcs8_shrouded_key_bag.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.PKCS8ShroudedKeyBag = void 0;
    var tslib_1 = (init_tslib_es6(), __toCommonJS(tslib_es6_exports));
    var asn1_pkcs8_1 = require_cjs9();
    var asn1_schema_1 = require_cjs2();
    var PKCS8ShroudedKeyBag = class PKCS8ShroudedKeyBag extends asn1_pkcs8_1.EncryptedPrivateKeyInfo {
    };
    exports.PKCS8ShroudedKeyBag = PKCS8ShroudedKeyBag;
    exports.PKCS8ShroudedKeyBag = PKCS8ShroudedKeyBag = tslib_1.__decorate([
      (0, asn1_schema_1.AsnType)({ type: asn1_schema_1.AsnTypeTypes.Sequence })
    ], PKCS8ShroudedKeyBag);
  }
});

// node_modules/@peculiar/asn1-pfx/build/cjs/bags/secret_bag.js
var require_secret_bag = __commonJS({
  "node_modules/@peculiar/asn1-pfx/build/cjs/bags/secret_bag.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.SecretBag = void 0;
    var tslib_1 = (init_tslib_es6(), __toCommonJS(tslib_es6_exports));
    var asn1_schema_1 = require_cjs2();
    var SecretBag = class {
      secretTypeId = "";
      secretValue = new ArrayBuffer(0);
      constructor(params = {}) {
        Object.assign(this, params);
      }
    };
    exports.SecretBag = SecretBag;
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({ type: asn1_schema_1.AsnPropTypes.ObjectIdentifier })
    ], SecretBag.prototype, "secretTypeId", void 0);
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({
        type: asn1_schema_1.AsnPropTypes.Any,
        context: 0
      })
    ], SecretBag.prototype, "secretValue", void 0);
  }
});

// node_modules/@peculiar/asn1-pfx/build/cjs/bags/index.js
var require_bags = __commonJS({
  "node_modules/@peculiar/asn1-pfx/build/cjs/bags/index.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    var tslib_1 = (init_tslib_es6(), __toCommonJS(tslib_es6_exports));
    tslib_1.__exportStar(require_cert_bag(), exports);
    tslib_1.__exportStar(require_crl_bag(), exports);
    tslib_1.__exportStar(require_key_bag(), exports);
    tslib_1.__exportStar(require_pkcs8_shrouded_key_bag(), exports);
    tslib_1.__exportStar(require_secret_bag(), exports);
    tslib_1.__exportStar(require_types5(), exports);
  }
});

// node_modules/@peculiar/asn1-pfx/build/cjs/mac_data.js
var require_mac_data = __commonJS({
  "node_modules/@peculiar/asn1-pfx/build/cjs/mac_data.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.MacData = void 0;
    var tslib_1 = (init_tslib_es6(), __toCommonJS(tslib_es6_exports));
    var asn1_rsa_1 = require_cjs7();
    var asn1_schema_1 = require_cjs2();
    var MacData = class {
      mac = new asn1_rsa_1.DigestInfo();
      macSalt = new asn1_schema_1.OctetString();
      iterations = 1;
      constructor(params = {}) {
        Object.assign(this, params);
      }
    };
    exports.MacData = MacData;
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({ type: asn1_rsa_1.DigestInfo })
    ], MacData.prototype, "mac", void 0);
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({ type: asn1_schema_1.OctetString })
    ], MacData.prototype, "macSalt", void 0);
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({
        type: asn1_schema_1.AsnPropTypes.Integer,
        defaultValue: 1
      })
    ], MacData.prototype, "iterations", void 0);
  }
});

// node_modules/@peculiar/asn1-pfx/build/cjs/pfx.js
var require_pfx = __commonJS({
  "node_modules/@peculiar/asn1-pfx/build/cjs/pfx.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.PFX = void 0;
    var tslib_1 = (init_tslib_es6(), __toCommonJS(tslib_es6_exports));
    var asn1_schema_1 = require_cjs2();
    var asn1_cms_1 = require_cjs5();
    var mac_data_1 = require_mac_data();
    var PFX = class {
      version = 3;
      authSafe = new asn1_cms_1.ContentInfo();
      macData = new mac_data_1.MacData();
      constructor(params = {}) {
        Object.assign(this, params);
      }
    };
    exports.PFX = PFX;
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({ type: asn1_schema_1.AsnPropTypes.Integer })
    ], PFX.prototype, "version", void 0);
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({ type: asn1_cms_1.ContentInfo })
    ], PFX.prototype, "authSafe", void 0);
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({
        type: mac_data_1.MacData,
        optional: true
      })
    ], PFX.prototype, "macData", void 0);
  }
});

// node_modules/@peculiar/asn1-pfx/build/cjs/safe_bag.js
var require_safe_bag = __commonJS({
  "node_modules/@peculiar/asn1-pfx/build/cjs/safe_bag.js"(exports) {
    "use strict";
    var SafeContents_1;
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.SafeContents = exports.SafeBag = void 0;
    var tslib_1 = (init_tslib_es6(), __toCommonJS(tslib_es6_exports));
    var asn1_schema_1 = require_cjs2();
    var attribute_1 = require_attribute3();
    var SafeBag = class {
      bagId = "";
      bagValue = new ArrayBuffer(0);
      bagAttributes;
      constructor(params = {}) {
        Object.assign(this, params);
      }
    };
    exports.SafeBag = SafeBag;
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({ type: asn1_schema_1.AsnPropTypes.ObjectIdentifier })
    ], SafeBag.prototype, "bagId", void 0);
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({
        type: asn1_schema_1.AsnPropTypes.Any,
        context: 0
      })
    ], SafeBag.prototype, "bagValue", void 0);
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({
        type: attribute_1.PKCS12Attribute,
        repeated: "set",
        optional: true
      })
    ], SafeBag.prototype, "bagAttributes", void 0);
    var SafeContents = SafeContents_1 = class SafeContents extends asn1_schema_1.AsnArray {
      constructor(items) {
        super(items);
        Object.setPrototypeOf(this, SafeContents_1.prototype);
      }
    };
    exports.SafeContents = SafeContents;
    exports.SafeContents = SafeContents = SafeContents_1 = tslib_1.__decorate([
      (0, asn1_schema_1.AsnType)({
        type: asn1_schema_1.AsnTypeTypes.Sequence,
        itemType: SafeBag
      })
    ], SafeContents);
  }
});

// node_modules/@peculiar/asn1-pfx/build/cjs/index.js
var require_cjs10 = __commonJS({
  "node_modules/@peculiar/asn1-pfx/build/cjs/index.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    var tslib_1 = (init_tslib_es6(), __toCommonJS(tslib_es6_exports));
    tslib_1.__exportStar(require_attribute3(), exports);
    tslib_1.__exportStar(require_authenticated_safe(), exports);
    tslib_1.__exportStar(require_bags(), exports);
    tslib_1.__exportStar(require_mac_data(), exports);
    tslib_1.__exportStar(require_object_identifiers6(), exports);
    tslib_1.__exportStar(require_pfx(), exports);
    tslib_1.__exportStar(require_safe_bag(), exports);
  }
});

// node_modules/@peculiar/asn1-pkcs9/build/cjs/index.js
var require_cjs11 = __commonJS({
  "node_modules/@peculiar/asn1-pkcs9/build/cjs/index.js"(exports) {
    "use strict";
    var ExtensionRequest_1;
    var ExtendedCertificateAttributes_1;
    var SMIMECapabilities_1;
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.DateOfBirth = exports.UnstructuredAddress = exports.UnstructuredName = exports.EmailAddress = exports.EncryptedPrivateKeyInfo = exports.UserPKCS12 = exports.Pkcs7PDU = exports.PKCS9String = exports.id_at_pseudonym = exports.crlTypes = exports.id_certTypes = exports.id_smime = exports.id_pkcs9_mr_signingTimeMatch = exports.id_pkcs9_mr_caseIgnoreMatch = exports.id_pkcs9_sx_signingTime = exports.id_pkcs9_sx_pkcs9String = exports.id_pkcs9_at_countryOfResidence = exports.id_pkcs9_at_countryOfCitizenship = exports.id_pkcs9_at_gender = exports.id_pkcs9_at_placeOfBirth = exports.id_pkcs9_at_dateOfBirth = exports.id_ietf_at = exports.id_pkcs9_at_pkcs7PDU = exports.id_pkcs9_at_sequenceNumber = exports.id_pkcs9_at_randomNonce = exports.id_pkcs9_at_encryptedPrivateKeyInfo = exports.id_pkcs9_at_pkcs15Token = exports.id_pkcs9_at_userPKCS12 = exports.id_pkcs9_at_localKeyId = exports.id_pkcs9_at_friendlyName = exports.id_pkcs9_at_smimeCapabilities = exports.id_pkcs9_at_extensionRequest = exports.id_pkcs9_at_signingDescription = exports.id_pkcs9_at_extendedCertificateAttributes = exports.id_pkcs9_at_unstructuredAddress = exports.id_pkcs9_at_challengePassword = exports.id_pkcs9_at_counterSignature = exports.id_pkcs9_at_signingTime = exports.id_pkcs9_at_messageDigest = exports.id_pkcs9_at_contentType = exports.id_pkcs9_at_unstructuredName = exports.id_pkcs9_at_emailAddress = exports.id_pkcs9_oc_naturalPerson = exports.id_pkcs9_oc_pkcsEntity = exports.id_pkcs9_mr = exports.id_pkcs9_sx = exports.id_pkcs9_at = exports.id_pkcs9_oc = exports.id_pkcs9_mo = exports.id_pkcs9 = void 0;
    exports.SMIMECapabilities = exports.SMIMECapability = exports.SigningDescription = exports.LocalKeyId = exports.FriendlyName = exports.ExtendedCertificateAttributes = exports.ExtensionRequest = exports.ChallengePassword = exports.CounterSignature = exports.SequenceNumber = exports.RandomNonce = exports.SigningTime = exports.MessageDigest = exports.ContentType = exports.Pseudonym = exports.CountryOfResidence = exports.CountryOfCitizenship = exports.Gender = exports.PlaceOfBirth = void 0;
    var tslib_1 = (init_tslib_es6(), __toCommonJS(tslib_es6_exports));
    var asn1_schema_1 = require_cjs2();
    var cms = tslib_1.__importStar(require_cjs5());
    var pfx = tslib_1.__importStar(require_cjs10());
    var pkcs8 = tslib_1.__importStar(require_cjs9());
    var x509 = tslib_1.__importStar(require_cjs3());
    var attr = tslib_1.__importStar(require_cjs4());
    exports.id_pkcs9 = "1.2.840.113549.1.9";
    exports.id_pkcs9_mo = `${exports.id_pkcs9}.0`;
    exports.id_pkcs9_oc = `${exports.id_pkcs9}.24`;
    exports.id_pkcs9_at = `${exports.id_pkcs9}.25`;
    exports.id_pkcs9_sx = `${exports.id_pkcs9}.26`;
    exports.id_pkcs9_mr = `${exports.id_pkcs9}.27`;
    exports.id_pkcs9_oc_pkcsEntity = `${exports.id_pkcs9_oc}.1`;
    exports.id_pkcs9_oc_naturalPerson = `${exports.id_pkcs9_oc}.2`;
    exports.id_pkcs9_at_emailAddress = `${exports.id_pkcs9}.1`;
    exports.id_pkcs9_at_unstructuredName = `${exports.id_pkcs9}.2`;
    exports.id_pkcs9_at_contentType = `${exports.id_pkcs9}.3`;
    exports.id_pkcs9_at_messageDigest = `${exports.id_pkcs9}.4`;
    exports.id_pkcs9_at_signingTime = `${exports.id_pkcs9}.5`;
    exports.id_pkcs9_at_counterSignature = `${exports.id_pkcs9}.6`;
    exports.id_pkcs9_at_challengePassword = `${exports.id_pkcs9}.7`;
    exports.id_pkcs9_at_unstructuredAddress = `${exports.id_pkcs9}.8`;
    exports.id_pkcs9_at_extendedCertificateAttributes = `${exports.id_pkcs9}.9`;
    exports.id_pkcs9_at_signingDescription = `${exports.id_pkcs9}.13`;
    exports.id_pkcs9_at_extensionRequest = `${exports.id_pkcs9}.14`;
    exports.id_pkcs9_at_smimeCapabilities = `${exports.id_pkcs9}.15`;
    exports.id_pkcs9_at_friendlyName = `${exports.id_pkcs9}.20`;
    exports.id_pkcs9_at_localKeyId = `${exports.id_pkcs9}.21`;
    exports.id_pkcs9_at_userPKCS12 = "2.16.840.1.113730.3.1.216";
    exports.id_pkcs9_at_pkcs15Token = `${exports.id_pkcs9_at}.1`;
    exports.id_pkcs9_at_encryptedPrivateKeyInfo = `${exports.id_pkcs9_at}.2`;
    exports.id_pkcs9_at_randomNonce = `${exports.id_pkcs9_at}.3`;
    exports.id_pkcs9_at_sequenceNumber = `${exports.id_pkcs9_at}.4`;
    exports.id_pkcs9_at_pkcs7PDU = `${exports.id_pkcs9_at}.5`;
    exports.id_ietf_at = "1.3.6.1.5.5.7.9";
    exports.id_pkcs9_at_dateOfBirth = `${exports.id_ietf_at}.1`;
    exports.id_pkcs9_at_placeOfBirth = `${exports.id_ietf_at}.2`;
    exports.id_pkcs9_at_gender = `${exports.id_ietf_at}.3`;
    exports.id_pkcs9_at_countryOfCitizenship = `${exports.id_ietf_at}.4`;
    exports.id_pkcs9_at_countryOfResidence = `${exports.id_ietf_at}.5`;
    exports.id_pkcs9_sx_pkcs9String = `${exports.id_pkcs9_sx}.1`;
    exports.id_pkcs9_sx_signingTime = `${exports.id_pkcs9_sx}.2`;
    exports.id_pkcs9_mr_caseIgnoreMatch = `${exports.id_pkcs9_mr}.1`;
    exports.id_pkcs9_mr_signingTimeMatch = `${exports.id_pkcs9_mr}.2`;
    exports.id_smime = `${exports.id_pkcs9}.16`;
    exports.id_certTypes = `${exports.id_pkcs9}.22`;
    exports.crlTypes = `${exports.id_pkcs9}.23`;
    exports.id_at_pseudonym = `${attr.id_at}.65`;
    var PKCS9String = class PKCS9String extends x509.DirectoryString {
      ia5String;
      constructor(params = {}) {
        super(params);
      }
      toString() {
        const o = {};
        o.toString();
        return this.ia5String || super.toString();
      }
    };
    exports.PKCS9String = PKCS9String;
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({ type: asn1_schema_1.AsnPropTypes.IA5String })
    ], PKCS9String.prototype, "ia5String", void 0);
    exports.PKCS9String = PKCS9String = tslib_1.__decorate([
      (0, asn1_schema_1.AsnType)({ type: asn1_schema_1.AsnTypeTypes.Choice })
    ], PKCS9String);
    var Pkcs7PDU = class Pkcs7PDU extends cms.ContentInfo {
    };
    exports.Pkcs7PDU = Pkcs7PDU;
    exports.Pkcs7PDU = Pkcs7PDU = tslib_1.__decorate([
      (0, asn1_schema_1.AsnType)({ type: asn1_schema_1.AsnTypeTypes.Sequence })
    ], Pkcs7PDU);
    var UserPKCS12 = class UserPKCS12 extends pfx.PFX {
    };
    exports.UserPKCS12 = UserPKCS12;
    exports.UserPKCS12 = UserPKCS12 = tslib_1.__decorate([
      (0, asn1_schema_1.AsnType)({ type: asn1_schema_1.AsnTypeTypes.Sequence })
    ], UserPKCS12);
    var EncryptedPrivateKeyInfo = class EncryptedPrivateKeyInfo extends pkcs8.EncryptedPrivateKeyInfo {
    };
    exports.EncryptedPrivateKeyInfo = EncryptedPrivateKeyInfo;
    exports.EncryptedPrivateKeyInfo = EncryptedPrivateKeyInfo = tslib_1.__decorate([
      (0, asn1_schema_1.AsnType)({ type: asn1_schema_1.AsnTypeTypes.Sequence })
    ], EncryptedPrivateKeyInfo);
    var EmailAddress = class EmailAddress {
      value;
      constructor(value = "") {
        this.value = value;
      }
      toString() {
        return this.value;
      }
    };
    exports.EmailAddress = EmailAddress;
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({ type: asn1_schema_1.AsnPropTypes.IA5String })
    ], EmailAddress.prototype, "value", void 0);
    exports.EmailAddress = EmailAddress = tslib_1.__decorate([
      (0, asn1_schema_1.AsnType)({ type: asn1_schema_1.AsnTypeTypes.Choice })
    ], EmailAddress);
    var UnstructuredName = class UnstructuredName extends PKCS9String {
    };
    exports.UnstructuredName = UnstructuredName;
    exports.UnstructuredName = UnstructuredName = tslib_1.__decorate([
      (0, asn1_schema_1.AsnType)({ type: asn1_schema_1.AsnTypeTypes.Choice })
    ], UnstructuredName);
    var UnstructuredAddress = class UnstructuredAddress extends x509.DirectoryString {
    };
    exports.UnstructuredAddress = UnstructuredAddress;
    exports.UnstructuredAddress = UnstructuredAddress = tslib_1.__decorate([
      (0, asn1_schema_1.AsnType)({ type: asn1_schema_1.AsnTypeTypes.Choice })
    ], UnstructuredAddress);
    var DateOfBirth = class DateOfBirth {
      value;
      constructor(value = /* @__PURE__ */ new Date()) {
        this.value = value;
      }
    };
    exports.DateOfBirth = DateOfBirth;
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({ type: asn1_schema_1.AsnPropTypes.GeneralizedTime })
    ], DateOfBirth.prototype, "value", void 0);
    exports.DateOfBirth = DateOfBirth = tslib_1.__decorate([
      (0, asn1_schema_1.AsnType)({ type: asn1_schema_1.AsnTypeTypes.Choice })
    ], DateOfBirth);
    var PlaceOfBirth = class PlaceOfBirth extends x509.DirectoryString {
    };
    exports.PlaceOfBirth = PlaceOfBirth;
    exports.PlaceOfBirth = PlaceOfBirth = tslib_1.__decorate([
      (0, asn1_schema_1.AsnType)({ type: asn1_schema_1.AsnTypeTypes.Choice })
    ], PlaceOfBirth);
    var Gender = class Gender {
      value;
      constructor(value = "M") {
        this.value = value;
      }
      toString() {
        return this.value;
      }
    };
    exports.Gender = Gender;
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({ type: asn1_schema_1.AsnPropTypes.PrintableString })
    ], Gender.prototype, "value", void 0);
    exports.Gender = Gender = tslib_1.__decorate([
      (0, asn1_schema_1.AsnType)({ type: asn1_schema_1.AsnTypeTypes.Choice })
    ], Gender);
    var CountryOfCitizenship = class CountryOfCitizenship {
      value;
      constructor(value = "") {
        this.value = value;
      }
      toString() {
        return this.value;
      }
    };
    exports.CountryOfCitizenship = CountryOfCitizenship;
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({ type: asn1_schema_1.AsnPropTypes.PrintableString })
    ], CountryOfCitizenship.prototype, "value", void 0);
    exports.CountryOfCitizenship = CountryOfCitizenship = tslib_1.__decorate([
      (0, asn1_schema_1.AsnType)({ type: asn1_schema_1.AsnTypeTypes.Choice })
    ], CountryOfCitizenship);
    var CountryOfResidence = class CountryOfResidence extends CountryOfCitizenship {
    };
    exports.CountryOfResidence = CountryOfResidence;
    exports.CountryOfResidence = CountryOfResidence = tslib_1.__decorate([
      (0, asn1_schema_1.AsnType)({ type: asn1_schema_1.AsnTypeTypes.Choice })
    ], CountryOfResidence);
    var Pseudonym = class Pseudonym extends x509.DirectoryString {
    };
    exports.Pseudonym = Pseudonym;
    exports.Pseudonym = Pseudonym = tslib_1.__decorate([
      (0, asn1_schema_1.AsnType)({ type: asn1_schema_1.AsnTypeTypes.Choice })
    ], Pseudonym);
    var ContentType = class ContentType {
      value;
      constructor(value = "") {
        this.value = value;
      }
      toString() {
        return this.value;
      }
    };
    exports.ContentType = ContentType;
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({ type: asn1_schema_1.AsnPropTypes.ObjectIdentifier })
    ], ContentType.prototype, "value", void 0);
    exports.ContentType = ContentType = tslib_1.__decorate([
      (0, asn1_schema_1.AsnType)({ type: asn1_schema_1.AsnTypeTypes.Choice })
    ], ContentType);
    var MessageDigest = class extends asn1_schema_1.OctetString {
    };
    exports.MessageDigest = MessageDigest;
    var SigningTime = class SigningTime extends x509.Time {
    };
    exports.SigningTime = SigningTime;
    exports.SigningTime = SigningTime = tslib_1.__decorate([
      (0, asn1_schema_1.AsnType)({ type: asn1_schema_1.AsnTypeTypes.Choice })
    ], SigningTime);
    var RandomNonce = class extends asn1_schema_1.OctetString {
    };
    exports.RandomNonce = RandomNonce;
    var SequenceNumber = class SequenceNumber {
      value;
      constructor(value = 0) {
        this.value = value;
      }
      toString() {
        return this.value.toString();
      }
    };
    exports.SequenceNumber = SequenceNumber;
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({ type: asn1_schema_1.AsnPropTypes.Integer })
    ], SequenceNumber.prototype, "value", void 0);
    exports.SequenceNumber = SequenceNumber = tslib_1.__decorate([
      (0, asn1_schema_1.AsnType)({ type: asn1_schema_1.AsnTypeTypes.Choice })
    ], SequenceNumber);
    var CounterSignature = class CounterSignature extends cms.SignerInfo {
    };
    exports.CounterSignature = CounterSignature;
    exports.CounterSignature = CounterSignature = tslib_1.__decorate([
      (0, asn1_schema_1.AsnType)({ type: asn1_schema_1.AsnTypeTypes.Sequence })
    ], CounterSignature);
    var ChallengePassword = class ChallengePassword extends x509.DirectoryString {
    };
    exports.ChallengePassword = ChallengePassword;
    exports.ChallengePassword = ChallengePassword = tslib_1.__decorate([
      (0, asn1_schema_1.AsnType)({ type: asn1_schema_1.AsnTypeTypes.Choice })
    ], ChallengePassword);
    var ExtensionRequest = ExtensionRequest_1 = class ExtensionRequest extends x509.Extensions {
      constructor(items) {
        super(items);
        Object.setPrototypeOf(this, ExtensionRequest_1.prototype);
      }
    };
    exports.ExtensionRequest = ExtensionRequest;
    exports.ExtensionRequest = ExtensionRequest = ExtensionRequest_1 = tslib_1.__decorate([
      (0, asn1_schema_1.AsnType)({ type: asn1_schema_1.AsnTypeTypes.Sequence })
    ], ExtensionRequest);
    var ExtendedCertificateAttributes = ExtendedCertificateAttributes_1 = class ExtendedCertificateAttributes extends asn1_schema_1.AsnArray {
      constructor(items) {
        super(items);
        Object.setPrototypeOf(this, ExtendedCertificateAttributes_1.prototype);
      }
    };
    exports.ExtendedCertificateAttributes = ExtendedCertificateAttributes;
    exports.ExtendedCertificateAttributes = ExtendedCertificateAttributes = ExtendedCertificateAttributes_1 = tslib_1.__decorate([
      (0, asn1_schema_1.AsnType)({
        type: asn1_schema_1.AsnTypeTypes.Set,
        itemType: cms.Attribute
      })
    ], ExtendedCertificateAttributes);
    var FriendlyName = class FriendlyName {
      value;
      constructor(value = "") {
        this.value = value;
      }
      toString() {
        return this.value;
      }
    };
    exports.FriendlyName = FriendlyName;
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({ type: asn1_schema_1.AsnPropTypes.BmpString })
    ], FriendlyName.prototype, "value", void 0);
    exports.FriendlyName = FriendlyName = tslib_1.__decorate([
      (0, asn1_schema_1.AsnType)({ type: asn1_schema_1.AsnTypeTypes.Choice })
    ], FriendlyName);
    var LocalKeyId = class extends asn1_schema_1.OctetString {
    };
    exports.LocalKeyId = LocalKeyId;
    var SigningDescription = class extends x509.DirectoryString {
    };
    exports.SigningDescription = SigningDescription;
    var SMIMECapability = class SMIMECapability extends x509.AlgorithmIdentifier {
    };
    exports.SMIMECapability = SMIMECapability;
    exports.SMIMECapability = SMIMECapability = tslib_1.__decorate([
      (0, asn1_schema_1.AsnType)({ type: asn1_schema_1.AsnTypeTypes.Sequence })
    ], SMIMECapability);
    var SMIMECapabilities = SMIMECapabilities_1 = class SMIMECapabilities extends asn1_schema_1.AsnArray {
      constructor(items) {
        super(items);
        Object.setPrototypeOf(this, SMIMECapabilities_1.prototype);
      }
    };
    exports.SMIMECapabilities = SMIMECapabilities;
    exports.SMIMECapabilities = SMIMECapabilities = SMIMECapabilities_1 = tslib_1.__decorate([
      (0, asn1_schema_1.AsnType)({
        type: asn1_schema_1.AsnTypeTypes.Sequence,
        itemType: SMIMECapability
      })
    ], SMIMECapabilities);
  }
});

// node_modules/@peculiar/asn1-x509-post-quantum/build/cjs/composite_signatures.js
var require_composite_signatures = __commonJS({
  "node_modules/@peculiar/asn1-x509-post-quantum/build/cjs/composite_signatures.js"(exports) {
    "use strict";
    var CompositeParams_1;
    var CompositeSignatureValue_1;
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.CompositeSignatureValue = exports.CompositeParams = exports.id_alg_composite = void 0;
    var tslib_1 = (init_tslib_es6(), __toCommonJS(tslib_es6_exports));
    var asn1_schema_1 = require_cjs2();
    var asn1_x509_1 = require_cjs3();
    exports.id_alg_composite = "1.3.6.1.4.1.18227.2.1";
    var CompositeParams = CompositeParams_1 = class CompositeParams extends asn1_schema_1.AsnArray {
      constructor(items) {
        super(items);
        Object.setPrototypeOf(this, CompositeParams_1.prototype);
      }
    };
    exports.CompositeParams = CompositeParams;
    exports.CompositeParams = CompositeParams = CompositeParams_1 = tslib_1.__decorate([
      (0, asn1_schema_1.AsnType)({
        type: asn1_schema_1.AsnTypeTypes.Sequence,
        itemType: asn1_x509_1.AlgorithmIdentifier
      })
    ], CompositeParams);
    var CompositeSignatureValue = CompositeSignatureValue_1 = class CompositeSignatureValue extends asn1_schema_1.AsnArray {
      constructor(items) {
        super(items);
        Object.setPrototypeOf(this, CompositeSignatureValue_1.prototype);
      }
    };
    exports.CompositeSignatureValue = CompositeSignatureValue;
    exports.CompositeSignatureValue = CompositeSignatureValue = CompositeSignatureValue_1 = tslib_1.__decorate([
      (0, asn1_schema_1.AsnType)({
        type: asn1_schema_1.AsnTypeTypes.Sequence,
        itemType: asn1_schema_1.AsnPropTypes.BitString
      })
    ], CompositeSignatureValue);
  }
});

// node_modules/@peculiar/asn1-asym-key/build/cjs/index.js
var require_cjs12 = __commonJS({
  "node_modules/@peculiar/asn1-asym-key/build/cjs/index.js"(exports) {
    "use strict";
    var AsymmetricKeyPackage_1;
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.EncryptedData = exports.EncryptedPrivateKeyInfo = exports.AsymmetricKeyPackage = exports.PrivateKeyInfo = exports.OneAsymmetricKey = exports.PublicKey = exports.PrivateKey = exports.PrivateKeyAlgorithmIdentifier = exports.Version = exports.id_ct_KP_aKeyPackage = void 0;
    var tslib_1 = (init_tslib_es6(), __toCommonJS(tslib_es6_exports));
    var asn1_pkcs8_1 = require_cjs9();
    var asn1_schema_1 = require_cjs2();
    var asn1_x509_1 = require_cjs3();
    exports.id_ct_KP_aKeyPackage = "2.16.840.1.101.2.1.78.5";
    var Version;
    (function(Version2) {
      Version2[Version2["v1"] = 0] = "v1";
      Version2[Version2["v2"] = 1] = "v2";
    })(Version || (exports.Version = Version = {}));
    var PrivateKeyAlgorithmIdentifier = class PrivateKeyAlgorithmIdentifier extends asn1_x509_1.AlgorithmIdentifier {
    };
    exports.PrivateKeyAlgorithmIdentifier = PrivateKeyAlgorithmIdentifier;
    exports.PrivateKeyAlgorithmIdentifier = PrivateKeyAlgorithmIdentifier = tslib_1.__decorate([
      (0, asn1_schema_1.AsnType)({ type: asn1_schema_1.AsnTypeTypes.Sequence })
    ], PrivateKeyAlgorithmIdentifier);
    var PrivateKey = class extends asn1_schema_1.OctetString {
    };
    exports.PrivateKey = PrivateKey;
    var PublicKey = class extends asn1_schema_1.BitString {
    };
    exports.PublicKey = PublicKey;
    var OneAsymmetricKey = class OneAsymmetricKey {
      version = Version.v1;
      privateKeyAlgorithm = new asn1_x509_1.AlgorithmIdentifier();
      privateKey = new ArrayBuffer(0);
      attributes;
      publicKey;
    };
    exports.OneAsymmetricKey = OneAsymmetricKey;
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({ type: asn1_schema_1.AsnPropTypes.Integer })
    ], OneAsymmetricKey.prototype, "version", void 0);
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({ type: asn1_x509_1.AlgorithmIdentifier })
    ], OneAsymmetricKey.prototype, "privateKeyAlgorithm", void 0);
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({ type: asn1_schema_1.AsnPropTypes.OctetString })
    ], OneAsymmetricKey.prototype, "privateKey", void 0);
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({
        type: asn1_pkcs8_1.Attributes,
        context: 0,
        implicit: true,
        optional: true
      })
    ], OneAsymmetricKey.prototype, "attributes", void 0);
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({
        type: asn1_schema_1.AsnPropTypes.BitString,
        context: 1,
        implicit: true,
        optional: true
      })
    ], OneAsymmetricKey.prototype, "publicKey", void 0);
    exports.OneAsymmetricKey = OneAsymmetricKey = tslib_1.__decorate([
      (0, asn1_schema_1.AsnType)({ type: asn1_schema_1.AsnTypeTypes.Sequence })
    ], OneAsymmetricKey);
    var PrivateKeyInfo = class PrivateKeyInfo extends OneAsymmetricKey {
    };
    exports.PrivateKeyInfo = PrivateKeyInfo;
    exports.PrivateKeyInfo = PrivateKeyInfo = tslib_1.__decorate([
      (0, asn1_schema_1.AsnType)({ type: asn1_schema_1.AsnTypeTypes.Sequence })
    ], PrivateKeyInfo);
    var AsymmetricKeyPackage = AsymmetricKeyPackage_1 = class AsymmetricKeyPackage extends asn1_schema_1.AsnArray {
      constructor(items) {
        super(items);
        Object.setPrototypeOf(this, AsymmetricKeyPackage_1.prototype);
      }
    };
    exports.AsymmetricKeyPackage = AsymmetricKeyPackage;
    exports.AsymmetricKeyPackage = AsymmetricKeyPackage = AsymmetricKeyPackage_1 = tslib_1.__decorate([
      (0, asn1_schema_1.AsnType)({
        type: asn1_schema_1.AsnTypeTypes.Sequence,
        itemType: OneAsymmetricKey
      })
    ], AsymmetricKeyPackage);
    var asn1_pkcs8_2 = require_cjs9();
    Object.defineProperty(exports, "EncryptedPrivateKeyInfo", { enumerable: true, get: function() {
      return asn1_pkcs8_2.EncryptedPrivateKeyInfo;
    } });
    Object.defineProperty(exports, "EncryptedData", { enumerable: true, get: function() {
      return asn1_pkcs8_2.EncryptedData;
    } });
  }
});

// node_modules/@peculiar/asn1-x509-post-quantum/build/cjs/composite_keys.js
var require_composite_keys = __commonJS({
  "node_modules/@peculiar/asn1-x509-post-quantum/build/cjs/composite_keys.js"(exports) {
    "use strict";
    var CompositePublicKey_1;
    var CompositePrivateKey_1;
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.CompositePrivateKey = exports.CompositePublicKeyBs = exports.CompositePublicKeyOs = exports.CompositePublicKey = exports.CompositeAlgorithmIdentifier = exports.id_Dilithium3_RSA = exports.id_Dilithium3_ECDSA_P256 = exports.id_composite_key = void 0;
    var tslib_1 = (init_tslib_es6(), __toCommonJS(tslib_es6_exports));
    var asn1_asym_key_1 = require_cjs12();
    var asn1_schema_1 = require_cjs2();
    var asn1_x509_1 = require_cjs3();
    exports.id_composite_key = "2.16.840.1.114027.80.4.1";
    exports.id_Dilithium3_ECDSA_P256 = "2.16.840.1.114027.80.5.1";
    exports.id_Dilithium3_RSA = "2.16.840.1.114027.80.5.2";
    var CompositeAlgorithmIdentifier = class CompositeAlgorithmIdentifier extends asn1_x509_1.AlgorithmIdentifier {
    };
    exports.CompositeAlgorithmIdentifier = CompositeAlgorithmIdentifier;
    exports.CompositeAlgorithmIdentifier = CompositeAlgorithmIdentifier = tslib_1.__decorate([
      (0, asn1_schema_1.AsnType)({ type: asn1_schema_1.AsnTypeTypes.Sequence })
    ], CompositeAlgorithmIdentifier);
    var CompositePublicKey = CompositePublicKey_1 = class CompositePublicKey extends asn1_schema_1.AsnArray {
      constructor(items) {
        super(items);
        Object.setPrototypeOf(this, CompositePublicKey_1.prototype);
      }
    };
    exports.CompositePublicKey = CompositePublicKey;
    exports.CompositePublicKey = CompositePublicKey = CompositePublicKey_1 = tslib_1.__decorate([
      (0, asn1_schema_1.AsnType)({
        type: asn1_schema_1.AsnTypeTypes.Sequence,
        itemType: asn1_x509_1.SubjectPublicKeyInfo
      })
    ], CompositePublicKey);
    var CompositePublicKeyOs = class extends asn1_schema_1.OctetString {
    };
    exports.CompositePublicKeyOs = CompositePublicKeyOs;
    var CompositePublicKeyBs = class extends asn1_schema_1.BitString {
    };
    exports.CompositePublicKeyBs = CompositePublicKeyBs;
    var CompositePrivateKey = CompositePrivateKey_1 = class CompositePrivateKey extends asn1_schema_1.AsnArray {
      constructor(items) {
        super(items);
        Object.setPrototypeOf(this, CompositePrivateKey_1.prototype);
      }
    };
    exports.CompositePrivateKey = CompositePrivateKey;
    exports.CompositePrivateKey = CompositePrivateKey = CompositePrivateKey_1 = tslib_1.__decorate([
      (0, asn1_schema_1.AsnType)({
        type: asn1_schema_1.AsnTypeTypes.Sequence,
        itemType: asn1_asym_key_1.OneAsymmetricKey
      })
    ], CompositePrivateKey);
  }
});

// node_modules/@peculiar/asn1-x509-post-quantum/build/cjs/object_identifiers.js
var require_object_identifiers7 = __commonJS({
  "node_modules/@peculiar/asn1-x509-post-quantum/build/cjs/object_identifiers.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.id_slh_dsa_shake_256f = exports.id_slh_dsa_shake_256s = exports.id_slh_dsa_shake_192f = exports.id_slh_dsa_shake_192s = exports.id_slh_dsa_shake_128f = exports.id_slh_dsa_shake_128s = exports.id_slh_dsa_sha2_256f = exports.id_slh_dsa_sha2_256s = exports.id_slh_dsa_sha2_192f = exports.id_slh_dsa_sha2_192s = exports.id_slh_dsa_sha2_128f = exports.id_slh_dsa_sha2_128s = exports.id_ml_dsa_87 = exports.id_ml_dsa_65 = exports.id_ml_dsa_44 = void 0;
    var id_sigAlgs = "2.16.840.1.101.3.4.3";
    exports.id_ml_dsa_44 = `${id_sigAlgs}.17`;
    exports.id_ml_dsa_65 = `${id_sigAlgs}.18`;
    exports.id_ml_dsa_87 = `${id_sigAlgs}.19`;
    exports.id_slh_dsa_sha2_128s = `${id_sigAlgs}.20`;
    exports.id_slh_dsa_sha2_128f = `${id_sigAlgs}.21`;
    exports.id_slh_dsa_sha2_192s = `${id_sigAlgs}.22`;
    exports.id_slh_dsa_sha2_192f = `${id_sigAlgs}.23`;
    exports.id_slh_dsa_sha2_256s = `${id_sigAlgs}.24`;
    exports.id_slh_dsa_sha2_256f = `${id_sigAlgs}.25`;
    exports.id_slh_dsa_shake_128s = `${id_sigAlgs}.26`;
    exports.id_slh_dsa_shake_128f = `${id_sigAlgs}.27`;
    exports.id_slh_dsa_shake_192s = `${id_sigAlgs}.28`;
    exports.id_slh_dsa_shake_192f = `${id_sigAlgs}.29`;
    exports.id_slh_dsa_shake_256s = `${id_sigAlgs}.30`;
    exports.id_slh_dsa_shake_256f = `${id_sigAlgs}.31`;
  }
});

// node_modules/@peculiar/asn1-x509-post-quantum/build/cjs/index.js
var require_cjs13 = __commonJS({
  "node_modules/@peculiar/asn1-x509-post-quantum/build/cjs/index.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    var tslib_1 = (init_tslib_es6(), __toCommonJS(tslib_es6_exports));
    tslib_1.__exportStar(require_composite_signatures(), exports);
    tslib_1.__exportStar(require_composite_keys(), exports);
    tslib_1.__exportStar(require_object_identifiers7(), exports);
  }
});

// node_modules/@peculiar/asn1-csr/build/cjs/attributes.js
var require_attributes2 = __commonJS({
  "node_modules/@peculiar/asn1-csr/build/cjs/attributes.js"(exports) {
    "use strict";
    var Attributes_1;
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.Attributes = void 0;
    var tslib_1 = (init_tslib_es6(), __toCommonJS(tslib_es6_exports));
    var asn1_schema_1 = require_cjs2();
    var asn1_x509_1 = require_cjs3();
    var Attributes = Attributes_1 = class Attributes extends asn1_schema_1.AsnArray {
      constructor(items) {
        super(items);
        Object.setPrototypeOf(this, Attributes_1.prototype);
      }
    };
    exports.Attributes = Attributes;
    exports.Attributes = Attributes = Attributes_1 = tslib_1.__decorate([
      (0, asn1_schema_1.AsnType)({
        type: asn1_schema_1.AsnTypeTypes.Sequence,
        itemType: asn1_x509_1.Attribute
      })
    ], Attributes);
  }
});

// node_modules/@peculiar/asn1-csr/build/cjs/certification_request_info.js
var require_certification_request_info = __commonJS({
  "node_modules/@peculiar/asn1-csr/build/cjs/certification_request_info.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.CertificationRequestInfo = void 0;
    var tslib_1 = (init_tslib_es6(), __toCommonJS(tslib_es6_exports));
    var asn1_schema_1 = require_cjs2();
    var asn1_x509_1 = require_cjs3();
    var attributes_1 = require_attributes2();
    var CertificationRequestInfo = class {
      version = 0;
      subject = new asn1_x509_1.Name();
      subjectPKInfo = new asn1_x509_1.SubjectPublicKeyInfo();
      attributes = new attributes_1.Attributes();
      constructor(params = {}) {
        Object.assign(this, params);
      }
    };
    exports.CertificationRequestInfo = CertificationRequestInfo;
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({ type: asn1_schema_1.AsnPropTypes.Integer })
    ], CertificationRequestInfo.prototype, "version", void 0);
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({ type: asn1_x509_1.Name })
    ], CertificationRequestInfo.prototype, "subject", void 0);
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({ type: asn1_x509_1.SubjectPublicKeyInfo })
    ], CertificationRequestInfo.prototype, "subjectPKInfo", void 0);
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({
        type: attributes_1.Attributes,
        implicit: true,
        context: 0,
        optional: true
      })
    ], CertificationRequestInfo.prototype, "attributes", void 0);
  }
});

// node_modules/@peculiar/asn1-csr/build/cjs/certification_request.js
var require_certification_request = __commonJS({
  "node_modules/@peculiar/asn1-csr/build/cjs/certification_request.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.CertificationRequest = void 0;
    var tslib_1 = (init_tslib_es6(), __toCommonJS(tslib_es6_exports));
    var asn1_schema_1 = require_cjs2();
    var asn1_x509_1 = require_cjs3();
    var certification_request_info_1 = require_certification_request_info();
    var CertificationRequest = class {
      certificationRequestInfo = new certification_request_info_1.CertificationRequestInfo();
      certificationRequestInfoRaw;
      signatureAlgorithm = new asn1_x509_1.AlgorithmIdentifier();
      signature = new ArrayBuffer(0);
      constructor(params = {}) {
        Object.assign(this, params);
      }
    };
    exports.CertificationRequest = CertificationRequest;
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({
        type: certification_request_info_1.CertificationRequestInfo,
        raw: true
      })
    ], CertificationRequest.prototype, "certificationRequestInfo", void 0);
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({ type: asn1_x509_1.AlgorithmIdentifier })
    ], CertificationRequest.prototype, "signatureAlgorithm", void 0);
    tslib_1.__decorate([
      (0, asn1_schema_1.AsnProp)({ type: asn1_schema_1.AsnPropTypes.BitString })
    ], CertificationRequest.prototype, "signature", void 0);
  }
});

// node_modules/@peculiar/asn1-csr/build/cjs/index.js
var require_cjs14 = __commonJS({
  "node_modules/@peculiar/asn1-csr/build/cjs/index.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    var tslib_1 = (init_tslib_es6(), __toCommonJS(tslib_es6_exports));
    tslib_1.__exportStar(require_attributes2(), exports);
    tslib_1.__exportStar(require_certification_request(), exports);
    tslib_1.__exportStar(require_certification_request_info(), exports);
  }
});

// node_modules/@peculiar/x509/build/x509.cjs.js
var require_x509_cjs = __commonJS({
  "node_modules/@peculiar/x509/build/x509.cjs.js"(exports) {
    "use strict";
    var asn1Schema = require_cjs2();
    var asn1X509 = require_cjs3();
    var pvtsutils = require_build();
    var tslib = (init_tslib_es6(), __toCommonJS(tslib_es6_exports));
    var asn1Cms = require_cjs5();
    var asn1Ecc = require_cjs6();
    var asn1Rsa = require_cjs7();
    var tsyringe = require_cjs8();
    var asnPkcs9 = require_cjs11();
    var asn1X509PostQuantum = require_cjs13();
    var asn1Csr = require_cjs14();
    function _interopNamespaceDefault(e) {
      var n = /* @__PURE__ */ Object.create(null);
      if (e) {
        Object.keys(e).forEach(function(k) {
          if (k !== "default") {
            var d = Object.getOwnPropertyDescriptor(e, k);
            Object.defineProperty(n, k, d.get ? d : {
              enumerable: true,
              get: function() {
                return e[k];
              }
            });
          }
        });
      }
      n.default = e;
      return Object.freeze(n);
    }
    var asn1X509__namespace = /* @__PURE__ */ _interopNamespaceDefault(asn1X509);
    var asn1Cms__namespace = /* @__PURE__ */ _interopNamespaceDefault(asn1Cms);
    var asn1Ecc__namespace = /* @__PURE__ */ _interopNamespaceDefault(asn1Ecc);
    var asn1Rsa__namespace = /* @__PURE__ */ _interopNamespaceDefault(asn1Rsa);
    var asnPkcs9__namespace = /* @__PURE__ */ _interopNamespaceDefault(asnPkcs9);
    var diAlgorithm = "crypto.algorithm";
    var AlgorithmProvider = class {
      getAlgorithms() {
        return tsyringe.container.resolveAll(diAlgorithm);
      }
      toAsnAlgorithm(alg) {
        const algCopy = { ...alg };
        if (algCopy.hash && typeof algCopy.hash === "string") {
          algCopy.hash = { name: algCopy.hash };
        }
        for (const algorithm of this.getAlgorithms()) {
          const res = algorithm.toAsnAlgorithm(algCopy);
          if (res) {
            return res;
          }
        }
        if (/^[0-9.]+$/.test(alg.name)) {
          const res = new asn1X509.AlgorithmIdentifier({ algorithm: alg.name });
          if ("parameters" in alg) {
            const unknown = alg;
            res.parameters = unknown.parameters;
          }
          return res;
        }
        throw new Error("Cannot convert WebCrypto algorithm to ASN.1 algorithm");
      }
      toWebAlgorithm(alg) {
        for (const algorithm of this.getAlgorithms()) {
          const res = algorithm.toWebAlgorithm(alg);
          if (res) {
            return res;
          }
        }
        const unknown = {
          name: alg.algorithm,
          parameters: alg.parameters
        };
        return unknown;
      }
    };
    var diAlgorithmProvider = "crypto.algorithmProvider";
    tsyringe.container.registerSingleton(diAlgorithmProvider, AlgorithmProvider);
    var EcAlgorithm_1;
    var idVersionOne = "1.3.36.3.3.2.8.1.1";
    var idBrainpoolP160r1 = `${idVersionOne}.1`;
    var idBrainpoolP160t1 = `${idVersionOne}.2`;
    var idBrainpoolP192r1 = `${idVersionOne}.3`;
    var idBrainpoolP192t1 = `${idVersionOne}.4`;
    var idBrainpoolP224r1 = `${idVersionOne}.5`;
    var idBrainpoolP224t1 = `${idVersionOne}.6`;
    var idBrainpoolP256r1 = `${idVersionOne}.7`;
    var idBrainpoolP256t1 = `${idVersionOne}.8`;
    var idBrainpoolP320r1 = `${idVersionOne}.9`;
    var idBrainpoolP320t1 = `${idVersionOne}.10`;
    var idBrainpoolP384r1 = `${idVersionOne}.11`;
    var idBrainpoolP384t1 = `${idVersionOne}.12`;
    var idBrainpoolP512r1 = `${idVersionOne}.13`;
    var idBrainpoolP512t1 = `${idVersionOne}.14`;
    var brainpoolP160r1 = "brainpoolP160r1";
    var brainpoolP160t1 = "brainpoolP160t1";
    var brainpoolP192r1 = "brainpoolP192r1";
    var brainpoolP192t1 = "brainpoolP192t1";
    var brainpoolP224r1 = "brainpoolP224r1";
    var brainpoolP224t1 = "brainpoolP224t1";
    var brainpoolP256r1 = "brainpoolP256r1";
    var brainpoolP256t1 = "brainpoolP256t1";
    var brainpoolP320r1 = "brainpoolP320r1";
    var brainpoolP320t1 = "brainpoolP320t1";
    var brainpoolP384r1 = "brainpoolP384r1";
    var brainpoolP384t1 = "brainpoolP384t1";
    var brainpoolP512r1 = "brainpoolP512r1";
    var brainpoolP512t1 = "brainpoolP512t1";
    var ECDSA = "ECDSA";
    exports.EcAlgorithm = EcAlgorithm_1 = class EcAlgorithm {
      toAsnAlgorithm(alg) {
        switch (alg.name.toLowerCase()) {
          case ECDSA.toLowerCase():
            if ("hash" in alg) {
              const hash = typeof alg.hash === "string" ? alg.hash : alg.hash.name;
              switch (hash.toLowerCase()) {
                case "sha-1":
                  return asn1Ecc__namespace.ecdsaWithSHA1;
                case "sha-256":
                  return asn1Ecc__namespace.ecdsaWithSHA256;
                case "sha-384":
                  return asn1Ecc__namespace.ecdsaWithSHA384;
                case "sha-512":
                  return asn1Ecc__namespace.ecdsaWithSHA512;
              }
            } else if ("namedCurve" in alg) {
              let parameters = "";
              switch (alg.namedCurve) {
                case "P-256":
                  parameters = asn1Ecc__namespace.id_secp256r1;
                  break;
                case "K-256":
                  parameters = EcAlgorithm_1.SECP256K1;
                  break;
                case "P-384":
                  parameters = asn1Ecc__namespace.id_secp384r1;
                  break;
                case "P-521":
                  parameters = asn1Ecc__namespace.id_secp521r1;
                  break;
                case brainpoolP160r1:
                  parameters = idBrainpoolP160r1;
                  break;
                case brainpoolP160t1:
                  parameters = idBrainpoolP160t1;
                  break;
                case brainpoolP192r1:
                  parameters = idBrainpoolP192r1;
                  break;
                case brainpoolP192t1:
                  parameters = idBrainpoolP192t1;
                  break;
                case brainpoolP224r1:
                  parameters = idBrainpoolP224r1;
                  break;
                case brainpoolP224t1:
                  parameters = idBrainpoolP224t1;
                  break;
                case brainpoolP256r1:
                  parameters = idBrainpoolP256r1;
                  break;
                case brainpoolP256t1:
                  parameters = idBrainpoolP256t1;
                  break;
                case brainpoolP320r1:
                  parameters = idBrainpoolP320r1;
                  break;
                case brainpoolP320t1:
                  parameters = idBrainpoolP320t1;
                  break;
                case brainpoolP384r1:
                  parameters = idBrainpoolP384r1;
                  break;
                case brainpoolP384t1:
                  parameters = idBrainpoolP384t1;
                  break;
                case brainpoolP512r1:
                  parameters = idBrainpoolP512r1;
                  break;
                case brainpoolP512t1:
                  parameters = idBrainpoolP512t1;
                  break;
              }
              if (parameters) {
                return new asn1X509.AlgorithmIdentifier({
                  algorithm: asn1Ecc__namespace.id_ecPublicKey,
                  parameters: asn1Schema.AsnConvert.serialize(new asn1Ecc__namespace.ECParameters({ namedCurve: parameters }))
                });
              }
            }
        }
        return null;
      }
      toWebAlgorithm(alg) {
        switch (alg.algorithm) {
          case asn1Ecc__namespace.id_ecdsaWithSHA1:
            return {
              name: ECDSA,
              hash: { name: "SHA-1" }
            };
          case asn1Ecc__namespace.id_ecdsaWithSHA256:
            return {
              name: ECDSA,
              hash: { name: "SHA-256" }
            };
          case asn1Ecc__namespace.id_ecdsaWithSHA384:
            return {
              name: ECDSA,
              hash: { name: "SHA-384" }
            };
          case asn1Ecc__namespace.id_ecdsaWithSHA512:
            return {
              name: ECDSA,
              hash: { name: "SHA-512" }
            };
          case asn1Ecc__namespace.id_ecPublicKey: {
            if (!alg.parameters) {
              throw new TypeError("Cannot get required parameters from EC algorithm");
            }
            const parameters = asn1Schema.AsnConvert.parse(alg.parameters, asn1Ecc__namespace.ECParameters);
            switch (parameters.namedCurve) {
              case asn1Ecc__namespace.id_secp256r1:
                return {
                  name: ECDSA,
                  namedCurve: "P-256"
                };
              case EcAlgorithm_1.SECP256K1:
                return {
                  name: ECDSA,
                  namedCurve: "K-256"
                };
              case asn1Ecc__namespace.id_secp384r1:
                return {
                  name: ECDSA,
                  namedCurve: "P-384"
                };
              case asn1Ecc__namespace.id_secp521r1:
                return {
                  name: ECDSA,
                  namedCurve: "P-521"
                };
              case idBrainpoolP160r1:
                return {
                  name: ECDSA,
                  namedCurve: brainpoolP160r1
                };
              case idBrainpoolP160t1:
                return {
                  name: ECDSA,
                  namedCurve: brainpoolP160t1
                };
              case idBrainpoolP192r1:
                return {
                  name: ECDSA,
                  namedCurve: brainpoolP192r1
                };
              case idBrainpoolP192t1:
                return {
                  name: ECDSA,
                  namedCurve: brainpoolP192t1
                };
              case idBrainpoolP224r1:
                return {
                  name: ECDSA,
                  namedCurve: brainpoolP224r1
                };
              case idBrainpoolP224t1:
                return {
                  name: ECDSA,
                  namedCurve: brainpoolP224t1
                };
              case idBrainpoolP256r1:
                return {
                  name: ECDSA,
                  namedCurve: brainpoolP256r1
                };
              case idBrainpoolP256t1:
                return {
                  name: ECDSA,
                  namedCurve: brainpoolP256t1
                };
              case idBrainpoolP320r1:
                return {
                  name: ECDSA,
                  namedCurve: brainpoolP320r1
                };
              case idBrainpoolP320t1:
                return {
                  name: ECDSA,
                  namedCurve: brainpoolP320t1
                };
              case idBrainpoolP384r1:
                return {
                  name: ECDSA,
                  namedCurve: brainpoolP384r1
                };
              case idBrainpoolP384t1:
                return {
                  name: ECDSA,
                  namedCurve: brainpoolP384t1
                };
              case idBrainpoolP512r1:
                return {
                  name: ECDSA,
                  namedCurve: brainpoolP512r1
                };
              case idBrainpoolP512t1:
                return {
                  name: ECDSA,
                  namedCurve: brainpoolP512t1
                };
            }
          }
        }
        return null;
      }
    };
    exports.EcAlgorithm.SECP256K1 = "1.3.132.0.10";
    exports.EcAlgorithm = EcAlgorithm_1 = tslib.__decorate([
      tsyringe.injectable()
    ], exports.EcAlgorithm);
    tsyringe.container.registerSingleton(diAlgorithm, exports.EcAlgorithm);
    var NAME = /* @__PURE__ */ Symbol("name");
    var VALUE = /* @__PURE__ */ Symbol("value");
    var TextObject = class {
      constructor(name, items = {}, value = "") {
        this[NAME] = name;
        this[VALUE] = value;
        for (const key in items) {
          this[key] = items[key];
        }
      }
    };
    TextObject.NAME = NAME;
    TextObject.VALUE = VALUE;
    var DefaultAlgorithmSerializer = class {
      static toTextObject(alg) {
        const obj = new TextObject("Algorithm Identifier", {}, OidSerializer.toString(alg.algorithm));
        if (alg.parameters) {
          switch (alg.algorithm) {
            case asn1Ecc__namespace.id_ecPublicKey: {
              const ecAlg = new exports.EcAlgorithm().toWebAlgorithm(alg);
              if (ecAlg && "namedCurve" in ecAlg) {
                obj["Named Curve"] = ecAlg.namedCurve;
              } else {
                obj["Parameters"] = alg.parameters;
              }
              break;
            }
            default:
              obj["Parameters"] = alg.parameters;
          }
        }
        return obj;
      }
    };
    var OidSerializer = class {
      static toString(oid) {
        const name = this.items[oid];
        if (name) {
          return name;
        }
        return oid;
      }
    };
    OidSerializer.items = {
      [asn1Rsa__namespace.id_sha1]: "sha1",
      [asn1Rsa__namespace.id_sha224]: "sha224",
      [asn1Rsa__namespace.id_sha256]: "sha256",
      [asn1Rsa__namespace.id_sha384]: "sha384",
      [asn1Rsa__namespace.id_sha512]: "sha512",
      [asn1Rsa__namespace.id_rsaEncryption]: "rsaEncryption",
      [asn1Rsa__namespace.id_sha1WithRSAEncryption]: "sha1WithRSAEncryption",
      [asn1Rsa__namespace.id_sha224WithRSAEncryption]: "sha224WithRSAEncryption",
      [asn1Rsa__namespace.id_sha256WithRSAEncryption]: "sha256WithRSAEncryption",
      [asn1Rsa__namespace.id_sha384WithRSAEncryption]: "sha384WithRSAEncryption",
      [asn1Rsa__namespace.id_sha512WithRSAEncryption]: "sha512WithRSAEncryption",
      [asn1Ecc__namespace.id_ecPublicKey]: "ecPublicKey",
      [asn1Ecc__namespace.id_ecdsaWithSHA1]: "ecdsaWithSHA1",
      [asn1Ecc__namespace.id_ecdsaWithSHA224]: "ecdsaWithSHA224",
      [asn1Ecc__namespace.id_ecdsaWithSHA256]: "ecdsaWithSHA256",
      [asn1Ecc__namespace.id_ecdsaWithSHA384]: "ecdsaWithSHA384",
      [asn1Ecc__namespace.id_ecdsaWithSHA512]: "ecdsaWithSHA512",
      [asn1X509__namespace.id_kp_serverAuth]: "TLS WWW server authentication",
      [asn1X509__namespace.id_kp_clientAuth]: "TLS WWW client authentication",
      [asn1X509__namespace.id_kp_codeSigning]: "Code Signing",
      [asn1X509__namespace.id_kp_emailProtection]: "E-mail Protection",
      [asn1X509__namespace.id_kp_timeStamping]: "Time Stamping",
      [asn1X509__namespace.id_kp_OCSPSigning]: "OCSP Signing",
      [asn1Cms__namespace.id_signedData]: "Signed Data"
    };
    var TextConverter = class {
      static serialize(obj) {
        return this.serializeObj(obj).join("\n");
      }
      static pad(deep = 0) {
        return "".padStart(2 * deep, " ");
      }
      static serializeObj(obj, deep = 0) {
        const res = [];
        let pad = this.pad(deep++);
        let value = "";
        const objValue = obj[TextObject.VALUE];
        if (objValue) {
          value = ` ${objValue}`;
        }
        res.push(`${pad}${obj[TextObject.NAME]}:${value}`);
        pad = this.pad(deep);
        for (const key in obj) {
          if (typeof key === "symbol") {
            continue;
          }
          const value2 = obj[key];
          const keyValue = key ? `${key}: ` : "";
          if (typeof value2 === "string" || typeof value2 === "number" || typeof value2 === "boolean") {
            res.push(`${pad}${keyValue}${value2}`);
          } else if (value2 instanceof Date) {
            res.push(`${pad}${keyValue}${value2.toUTCString()}`);
          } else if (Array.isArray(value2)) {
            for (const obj2 of value2) {
              obj2[TextObject.NAME] = key;
              res.push(...this.serializeObj(obj2, deep));
            }
          } else if (value2 instanceof TextObject) {
            value2[TextObject.NAME] = key;
            res.push(...this.serializeObj(value2, deep));
          } else if (pvtsutils.BufferSourceConverter.isBufferSource(value2)) {
            if (key) {
              res.push(`${pad}${keyValue}`);
              res.push(...this.serializeBufferSource(value2, deep + 1));
            } else {
              res.push(...this.serializeBufferSource(value2, deep));
            }
          } else if ("toTextObject" in value2) {
            const obj2 = value2.toTextObject();
            obj2[TextObject.NAME] = key;
            res.push(...this.serializeObj(obj2, deep));
          } else {
            throw new TypeError("Cannot serialize data in text format. Unsupported type.");
          }
        }
        return res;
      }
      static serializeBufferSource(buffer, deep = 0) {
        const pad = this.pad(deep);
        const view = pvtsutils.BufferSourceConverter.toUint8Array(buffer);
        const res = [];
        for (let i = 0; i < view.length; ) {
          const row = [];
          for (let j = 0; j < 16 && i < view.length; j++) {
            if (j === 8) {
              row.push("");
            }
            const hex = view[i++].toString(16).padStart(2, "0");
            row.push(hex);
          }
          res.push(`${pad}${row.join(" ")}`);
        }
        return res;
      }
      static serializeAlgorithm(alg) {
        return this.algorithmSerializer.toTextObject(alg);
      }
    };
    TextConverter.oidSerializer = OidSerializer;
    TextConverter.algorithmSerializer = DefaultAlgorithmSerializer;
    var _AsnData_rawData;
    var _AsnData_options;
    var AsnData = class _AsnData {
      get parseOptions() {
        return tslib.__classPrivateFieldGet(this, _AsnData_options, "f");
      }
      get rawData() {
        if (!tslib.__classPrivateFieldGet(this, _AsnData_rawData, "f")) {
          tslib.__classPrivateFieldSet(this, _AsnData_rawData, asn1Schema.AsnConvert.serialize(this.asn), "f");
        }
        return tslib.__classPrivateFieldGet(this, _AsnData_rawData, "f");
      }
      constructor(...args) {
        _AsnData_rawData.set(this, void 0);
        _AsnData_options.set(this, void 0);
        if (pvtsutils.BufferSourceConverter.isBufferSource(args[0])) {
          tslib.__classPrivateFieldSet(this, _AsnData_options, args[2], "f");
          this.asn = asn1Schema.AsnConvert.parse(args[0], args[1], args[2]);
          tslib.__classPrivateFieldSet(this, _AsnData_rawData, pvtsutils.BufferSourceConverter.toArrayBuffer(args[0]), "f");
          this.onInit(this.asn);
        } else {
          tslib.__classPrivateFieldSet(this, _AsnData_options, args[1], "f");
          this.asn = args[0];
          this.onInit(this.asn);
        }
      }
      equal(data) {
        if (data instanceof _AsnData) {
          return pvtsutils.isEqual(data.rawData, this.rawData);
        }
        return false;
      }
      toString(format = "text") {
        switch (format) {
          case "asn":
            return asn1Schema.AsnConvert.toString(this.rawData, tslib.__classPrivateFieldGet(this, _AsnData_options, "f"));
          case "text":
            return TextConverter.serialize(this.toTextObject());
          case "hex":
            return pvtsutils.Convert.ToHex(this.rawData);
          case "base64":
            return pvtsutils.Convert.ToBase64(this.rawData);
          case "base64url":
            return pvtsutils.Convert.ToBase64Url(this.rawData);
          default:
            throw TypeError("Argument 'format' is unsupported value");
        }
      }
      getTextName() {
        const constructor = this.constructor;
        return constructor.NAME;
      }
      toTextObject() {
        const obj = this.toTextObjectEmpty();
        obj[""] = this.rawData;
        return obj;
      }
      toTextObjectEmpty(value) {
        return new TextObject(this.getTextName(), {}, value);
      }
    };
    _AsnData_rawData = /* @__PURE__ */ new WeakMap(), _AsnData_options = /* @__PURE__ */ new WeakMap();
    AsnData.NAME = "ASN";
    var Extension = class _Extension extends AsnData {
      constructor(...args) {
        let raw;
        let options;
        if (pvtsutils.BufferSourceConverter.isBufferSource(args[0])) {
          raw = pvtsutils.BufferSourceConverter.toArrayBuffer(args[0]);
          options = args[1];
        } else {
          raw = asn1Schema.AsnConvert.serialize(new asn1X509.Extension({
            extnID: args[0],
            critical: args[1],
            extnValue: new asn1Schema.OctetString(pvtsutils.BufferSourceConverter.toArrayBuffer(args[2]))
          }));
        }
        super(raw, asn1X509.Extension, options);
      }
      onInit(asn) {
        this.type = asn.extnID;
        this.critical = asn.critical;
        this.value = asn.extnValue.buffer;
      }
      toTextObject() {
        const obj = this.toTextObjectWithoutValue();
        obj[""] = this.value;
        return obj;
      }
      toTextObjectWithoutValue() {
        const obj = this.toTextObjectEmpty(this.critical ? "critical" : void 0);
        if (obj[TextObject.NAME] === _Extension.NAME) {
          obj[TextObject.NAME] = OidSerializer.toString(this.type);
        }
        return obj;
      }
    };
    var _a;
    var CryptoProvider = class _CryptoProvider {
      static isCryptoKeyPair(data) {
        return data && data.privateKey && data.publicKey;
      }
      static isCryptoKey(data) {
        return data && data.usages && data.type && data.algorithm && data.extractable !== void 0;
      }
      constructor() {
        this.items = /* @__PURE__ */ new Map();
        this[_a] = "CryptoProvider";
        if (typeof self !== "undefined" && typeof crypto !== "undefined") {
          this.set(_CryptoProvider.DEFAULT, crypto);
        } else if (typeof global !== "undefined" && global.crypto && global.crypto.subtle) {
          this.set(_CryptoProvider.DEFAULT, global.crypto);
        }
      }
      clear() {
        this.items.clear();
      }
      delete(key) {
        return this.items.delete(key);
      }
      forEach(callbackfn, thisArg) {
        return this.items.forEach(callbackfn, thisArg);
      }
      has(key) {
        return this.items.has(key);
      }
      get size() {
        return this.items.size;
      }
      entries() {
        return this.items.entries();
      }
      keys() {
        return this.items.keys();
      }
      values() {
        return this.items.values();
      }
      [Symbol.iterator]() {
        return this.items[Symbol.iterator]();
      }
      get(key = _CryptoProvider.DEFAULT) {
        const crypto2 = this.items.get(key.toLowerCase());
        if (!crypto2) {
          throw new Error(`Cannot get Crypto by name '${key}'`);
        }
        return crypto2;
      }
      set(key, value) {
        if (typeof key === "string") {
          if (!value) {
            throw new TypeError("Argument 'value' is required");
          }
          this.items.set(key.toLowerCase(), value);
        } else {
          this.items.set(_CryptoProvider.DEFAULT, key);
        }
        return this;
      }
    };
    _a = Symbol.toStringTag;
    CryptoProvider.DEFAULT = "default";
    var cryptoProvider = new CryptoProvider();
    var OID_REGEX = /^[0-2](?:\.[1-9][0-9]*)+$/;
    function isOID(id2) {
      return new RegExp(OID_REGEX).test(id2);
    }
    var NameIdentifier = class {
      constructor(names2 = {}) {
        this.items = {};
        for (const id2 in names2) {
          this.register(id2, names2[id2]);
        }
      }
      get(idOrName) {
        return this.items[idOrName] || null;
      }
      findId(idOrName) {
        if (!isOID(idOrName)) {
          return this.get(idOrName);
        }
        return idOrName;
      }
      register(id2, name) {
        this.items[id2] = name;
        this.items[name] = id2;
      }
    };
    var names = new NameIdentifier();
    names.register("CN", "2.5.4.3");
    names.register("L", "2.5.4.7");
    names.register("ST", "2.5.4.8");
    names.register("O", "2.5.4.10");
    names.register("OU", "2.5.4.11");
    names.register("C", "2.5.4.6");
    names.register("DC", "0.9.2342.19200300.100.1.25");
    names.register("E", "1.2.840.113549.1.9.1");
    names.register("G", "2.5.4.42");
    names.register("I", "2.5.4.43");
    names.register("SN", "2.5.4.4");
    names.register("T", "2.5.4.12");
    function replaceUnknownCharacter(text, char) {
      return `\\${pvtsutils.Convert.ToHex(pvtsutils.Convert.FromUtf8String(char)).toUpperCase()}`;
    }
    function escape2(data) {
      return data.replace(/([,+"\\<>;])/g, "\\$1").replace(/^([ #])/, "\\$1").replace(/([ ]$)/, "\\$1").replace(/([\r\n\t])/, replaceUnknownCharacter);
    }
    var Name = class _Name {
      static isASCII(text) {
        for (let i = 0; i < text.length; i++) {
          const code = text.charCodeAt(i);
          if (code > 255) {
            return false;
          }
        }
        return true;
      }
      static isPrintableString(text) {
        return /^[A-Za-z0-9 '()+,-./:=?]*$/g.test(text);
      }
      constructor(data, extraNames = {}) {
        this.extraNames = new NameIdentifier();
        this.asn = new asn1X509.Name();
        for (const key in extraNames) {
          if (Object.prototype.hasOwnProperty.call(extraNames, key)) {
            const value = extraNames[key];
            this.extraNames.register(key, value);
          }
        }
        if (typeof data === "string") {
          this.asn = this.fromString(data);
        } else if (data instanceof asn1X509.Name) {
          this.asn = data;
        } else if (pvtsutils.BufferSourceConverter.isBufferSource(data)) {
          this.asn = asn1Schema.AsnConvert.parse(data, asn1X509.Name);
        } else {
          this.asn = this.fromJSON(data);
        }
      }
      getField(idOrName) {
        const id2 = this.extraNames.findId(idOrName) || names.findId(idOrName);
        const res = [];
        for (const name of this.asn) {
          for (const rdn of name) {
            if (rdn.type === id2) {
              res.push(rdn.value.toString());
            }
          }
        }
        return res;
      }
      getName(idOrName) {
        return this.extraNames.get(idOrName) || names.get(idOrName);
      }
      toString() {
        return this.asn.map((rdn) => rdn.map((o) => {
          const type = this.getName(o.type) || o.type;
          const value = o.value.anyValue ? `#${pvtsutils.Convert.ToHex(o.value.anyValue)}` : escape2(o.value.toString());
          return `${type}=${value}`;
        }).join("+")).join(", ");
      }
      toJSON() {
        var _a2;
        const json = [];
        for (const rdn of this.asn) {
          const jsonItem = {};
          for (const attr of rdn) {
            const type = this.getName(attr.type) || attr.type;
            (_a2 = jsonItem[type]) !== null && _a2 !== void 0 ? _a2 : jsonItem[type] = [];
            jsonItem[type].push(attr.value.anyValue ? `#${pvtsutils.Convert.ToHex(attr.value.anyValue)}` : attr.value.toString());
          }
          json.push(jsonItem);
        }
        return json;
      }
      fromString(data) {
        const asn = new asn1X509.Name();
        const regex = /(\d\.[\d.]*\d|[A-Za-z]+)=((?:"")|(?:".*?[^\\]")|(?:[^,+"\\](?=[,+]|$))|(?:[^,+].*?(?:[^\\][,+]))|(?:))([,+])?/g;
        let matches = null;
        let level = ",";
        while (matches = regex.exec(`${data},`)) {
          let [, type, value] = matches;
          const lastChar = value[value.length - 1];
          if (lastChar === "," || lastChar === "+") {
            value = value.slice(0, value.length - 1);
            matches[3] = lastChar;
          }
          const next = matches[3];
          type = this.getTypeOid(type);
          const attr = this.createAttribute(type, value);
          if (level === "+") {
            asn[asn.length - 1].push(attr);
          } else {
            asn.push(new asn1X509.RelativeDistinguishedName([attr]));
          }
          level = next;
        }
        return asn;
      }
      fromJSON(data) {
        const asn = new asn1X509.Name();
        for (const item of data) {
          const asnRdn = new asn1X509.RelativeDistinguishedName();
          for (const type in item) {
            const typeId = this.getTypeOid(type);
            const values = item[type];
            for (const value of values) {
              const asnAttr = this.createAttribute(typeId, value);
              asnRdn.push(asnAttr);
            }
          }
          asn.push(asnRdn);
        }
        return asn;
      }
      getTypeOid(type) {
        if (!/[\d.]+/.test(type)) {
          type = this.getName(type) || "";
        }
        if (!type) {
          throw new Error(`Cannot get OID for name type '${type}'`);
        }
        return type;
      }
      createAttribute(type, value) {
        const attr = new asn1X509.AttributeTypeAndValue({ type });
        if (typeof value === "object") {
          for (const key in value) {
            switch (key) {
              case "ia5String":
                attr.value.ia5String = value[key];
                break;
              case "utf8String":
                attr.value.utf8String = value[key];
                break;
              case "universalString":
                attr.value.universalString = value[key];
                break;
              case "bmpString":
                attr.value.bmpString = value[key];
                break;
              case "printableString":
                attr.value.printableString = value[key];
                break;
            }
          }
        } else if (value[0] === "#") {
          attr.value.anyValue = pvtsutils.Convert.FromHex(value.slice(1));
        } else {
          const processedValue = this.processStringValue(value);
          if (type === this.getName("E") || type === this.getName("DC")) {
            attr.value.ia5String = processedValue;
          } else {
            if (_Name.isPrintableString(processedValue)) {
              attr.value.printableString = processedValue;
            } else {
              attr.value.utf8String = processedValue;
            }
          }
        }
        return attr;
      }
      processStringValue(value) {
        const quotedMatches = /"(.*?[^\\])?"/.exec(value);
        if (quotedMatches) {
          value = quotedMatches[1];
        }
        return value.replace(/\\0a/gi, "\n").replace(/\\0d/gi, "\r").replace(/\\0g/gi, "	").replace(/\\(.)/g, "$1");
      }
      toArrayBuffer() {
        return asn1Schema.AsnConvert.serialize(this.asn);
      }
      async getThumbprint(arg1, arg2) {
        let crypto2;
        let algorithm = "SHA-1";
        if (arg1) {
          if (typeof arg1 === "object" && "subtle" in arg1) {
            crypto2 = arg1;
          } else {
            algorithm = arg1;
            crypto2 = arg2;
          }
        }
        crypto2 !== null && crypto2 !== void 0 ? crypto2 : crypto2 = cryptoProvider.get();
        return await crypto2.subtle.digest(algorithm, this.toArrayBuffer());
      }
    };
    var ERR_GN_CONSTRUCTOR = "Cannot initialize GeneralName from ASN.1 data.";
    var ERR_GN_STRING_FORMAT = `${ERR_GN_CONSTRUCTOR} Unsupported string format in use.`;
    var ERR_GUID = `${ERR_GN_CONSTRUCTOR} Value doesn't match to GUID regular expression.`;
    var GUID_REGEX = /^([0-9a-f]{8})-?([0-9a-f]{4})-?([0-9a-f]{4})-?([0-9a-f]{4})-?([0-9a-f]{12})$/i;
    var id_GUID = "1.3.6.1.4.1.311.25.1";
    var id_UPN = "1.3.6.1.4.1.311.20.2.3";
    var DNS = "dns";
    var DN = "dn";
    var EMAIL = "email";
    var IP = "ip";
    var URL2 = "url";
    var GUID = "guid";
    var UPN = "upn";
    var REGISTERED_ID = "id";
    var GeneralName = class extends AsnData {
      constructor(...args) {
        let name;
        if (args.length === 2) {
          switch (args[0]) {
            case DN: {
              const derName = new Name(args[1]).toArrayBuffer();
              const asnName = asn1Schema.AsnConvert.parse(derName, asn1X509__namespace.Name);
              name = new asn1X509__namespace.GeneralName({ directoryName: asnName });
              break;
            }
            case DNS:
              name = new asn1X509__namespace.GeneralName({ dNSName: args[1] });
              break;
            case EMAIL:
              name = new asn1X509__namespace.GeneralName({ rfc822Name: args[1] });
              break;
            case GUID: {
              const matches = new RegExp(GUID_REGEX, "i").exec(args[1]);
              if (!matches) {
                throw new Error("Cannot parse GUID value. Value doesn't match to regular expression");
              }
              const hex = matches.slice(1).map((o, i) => {
                if (i < 3) {
                  return pvtsutils.Convert.ToHex(new Uint8Array(pvtsutils.Convert.FromHex(o)).reverse());
                }
                return o;
              }).join("");
              name = new asn1X509__namespace.GeneralName({
                otherName: new asn1X509__namespace.OtherName({
                  typeId: id_GUID,
                  value: asn1Schema.AsnConvert.serialize(new asn1Schema.OctetString(pvtsutils.Convert.FromHex(hex)))
                })
              });
              break;
            }
            case IP:
              name = new asn1X509__namespace.GeneralName({ iPAddress: args[1] });
              break;
            case REGISTERED_ID:
              name = new asn1X509__namespace.GeneralName({ registeredID: args[1] });
              break;
            case UPN: {
              name = new asn1X509__namespace.GeneralName({
                otherName: new asn1X509__namespace.OtherName({
                  typeId: id_UPN,
                  value: asn1Schema.AsnConvert.serialize(asn1Schema.AsnUtf8StringConverter.toASN(args[1]))
                })
              });
              break;
            }
            case URL2:
              name = new asn1X509__namespace.GeneralName({ uniformResourceIdentifier: args[1] });
              break;
            default:
              throw new Error("Cannot create GeneralName. Unsupported type of the name");
          }
        } else if (pvtsutils.BufferSourceConverter.isBufferSource(args[0])) {
          name = asn1Schema.AsnConvert.parse(args[0], asn1X509__namespace.GeneralName);
        } else {
          name = args[0];
        }
        super(name);
      }
      onInit(asn) {
        if (asn.dNSName != void 0) {
          this.type = DNS;
          this.value = asn.dNSName;
        } else if (asn.rfc822Name != void 0) {
          this.type = EMAIL;
          this.value = asn.rfc822Name;
        } else if (asn.iPAddress != void 0) {
          this.type = IP;
          this.value = asn.iPAddress;
        } else if (asn.uniformResourceIdentifier != void 0) {
          this.type = URL2;
          this.value = asn.uniformResourceIdentifier;
        } else if (asn.registeredID != void 0) {
          this.type = REGISTERED_ID;
          this.value = asn.registeredID;
        } else if (asn.directoryName != void 0) {
          this.type = DN;
          this.value = new Name(asn.directoryName).toString();
        } else if (asn.otherName != void 0) {
          if (asn.otherName.typeId === id_GUID) {
            this.type = GUID;
            const guid = asn1Schema.AsnConvert.parse(asn.otherName.value, asn1Schema.OctetString);
            const matches = new RegExp(GUID_REGEX, "i").exec(pvtsutils.Convert.ToHex(guid));
            if (!matches) {
              throw new Error(ERR_GUID);
            }
            this.value = matches.slice(1).map((o, i) => {
              if (i < 3) {
                return pvtsutils.Convert.ToHex(new Uint8Array(pvtsutils.Convert.FromHex(o)).reverse());
              }
              return o;
            }).join("-");
          } else if (asn.otherName.typeId === id_UPN) {
            this.type = UPN;
            this.value = asn1Schema.AsnConvert.parse(asn.otherName.value, asn1X509__namespace.DirectoryString).toString();
          } else {
            throw new Error(ERR_GN_STRING_FORMAT);
          }
        } else {
          throw new Error(ERR_GN_STRING_FORMAT);
        }
      }
      toJSON() {
        return {
          type: this.type,
          value: this.value
        };
      }
      toTextObject() {
        let type;
        switch (this.type) {
          case DN:
          case DNS:
          case GUID:
          case IP:
          case REGISTERED_ID:
          case UPN:
          case URL2:
            type = this.type.toUpperCase();
            break;
          case EMAIL:
            type = "Email";
            break;
          default:
            throw new Error("Unsupported GeneralName type");
        }
        let value = this.value;
        if (this.type === REGISTERED_ID) {
          value = OidSerializer.toString(value);
        }
        return new TextObject(type, void 0, value);
      }
    };
    var GeneralNames = class extends AsnData {
      constructor(params) {
        let names2;
        if (params instanceof asn1X509__namespace.GeneralNames) {
          names2 = params;
        } else if (Array.isArray(params)) {
          const items = [];
          for (const name of params) {
            if (name instanceof asn1X509__namespace.GeneralName) {
              items.push(name);
            } else {
              const asnName = asn1Schema.AsnConvert.parse(new GeneralName(name.type, name.value).rawData, asn1X509__namespace.GeneralName);
              items.push(asnName);
            }
          }
          names2 = new asn1X509__namespace.GeneralNames(items);
        } else if (pvtsutils.BufferSourceConverter.isBufferSource(params)) {
          names2 = asn1Schema.AsnConvert.parse(params, asn1X509__namespace.GeneralNames);
        } else {
          throw new Error("Cannot initialize GeneralNames. Incorrect incoming arguments");
        }
        super(names2);
      }
      onInit(asn) {
        const items = [];
        for (const asnName of asn) {
          let name = null;
          try {
            name = new GeneralName(asnName);
          } catch {
            continue;
          }
          items.push(name);
        }
        this.items = items;
      }
      toJSON() {
        return this.items.map((o) => o.toJSON());
      }
      toTextObject() {
        const res = super.toTextObjectEmpty();
        for (const name of this.items) {
          const nameObj = name.toTextObject();
          let field = res[nameObj[TextObject.NAME]];
          if (!Array.isArray(field)) {
            field = [];
            res[nameObj[TextObject.NAME]] = field;
          }
          field.push(nameObj);
        }
        return res;
      }
    };
    GeneralNames.NAME = "GeneralNames";
    var rPaddingTag = "-{5}";
    var rEolChars = "\\n";
    var rNameTag = `[^${rEolChars}]+`;
    var rBeginTag = `${rPaddingTag}BEGIN (${rNameTag}(?=${rPaddingTag}))${rPaddingTag}`;
    var rEndTag = `${rPaddingTag}END \\1${rPaddingTag}`;
    var rEolGroup = "\\n";
    var rHeaderKey = `[^:${rEolChars}]+`;
    var rHeaderValue = `(?:[^${rEolChars}]+${rEolGroup}(?: +[^${rEolChars}]+${rEolGroup})*)`;
    var rBase64Chars = "[a-zA-Z0-9=+/]+";
    var rBase64 = `(?:${rBase64Chars}${rEolGroup})+`;
    var rPem = `${rBeginTag}${rEolGroup}(?:((?:${rHeaderKey}: ${rHeaderValue})+))?${rEolGroup}?(${rBase64})${rEndTag}`;
    var rEolPattern = new RegExp(`[${rEolChars}]+`, "g");
    var PemConverter = class {
      static isPem(data) {
        return typeof data === "string" && new RegExp(rPem, "g").test(data.replace(/\r/g, ""));
      }
      static decodeWithHeaders(pem) {
        pem = pem.replace(/\r/g, "");
        const pattern = new RegExp(rPem, "g");
        const res = [];
        let matches = null;
        while (matches = pattern.exec(pem)) {
          const base64 = matches[3].replace(rEolPattern, "");
          const pemStruct = {
            type: matches[1],
            headers: [],
            rawData: pvtsutils.Convert.FromBase64(base64)
          };
          const headersString = matches[2];
          if (headersString) {
            const headers = headersString.split(new RegExp(rEolGroup, "g"));
            let lastHeader = null;
            for (const header of headers) {
              const [key, value] = header.split(/:(.*)/);
              if (value === void 0) {
                if (!lastHeader) {
                  throw new Error("Cannot parse PEM string. Incorrect header value");
                }
                lastHeader.value += key.trim();
              } else {
                if (lastHeader) {
                  pemStruct.headers.push(lastHeader);
                }
                lastHeader = {
                  key,
                  value: value.trim()
                };
              }
            }
            if (lastHeader) {
              pemStruct.headers.push(lastHeader);
            }
          }
          res.push(pemStruct);
        }
        return res;
      }
      static decode(pem) {
        const blocks = this.decodeWithHeaders(pem);
        return blocks.map((o) => o.rawData);
      }
      static decodeFirst(pem) {
        const items = this.decode(pem);
        if (!items.length) {
          throw new RangeError("PEM string doesn't contain any objects");
        }
        return items[0];
      }
      static encode(rawData, tag) {
        if (Array.isArray(rawData)) {
          const raws = new Array();
          if (tag) {
            rawData.forEach((element) => {
              if (!pvtsutils.BufferSourceConverter.isBufferSource(element)) {
                throw new TypeError("Cannot encode array of BufferSource in PEM format. Not all items of the array are BufferSource");
              }
              raws.push(this.encodeStruct({
                type: tag,
                rawData: pvtsutils.BufferSourceConverter.toArrayBuffer(element)
              }));
            });
          } else {
            rawData.forEach((element) => {
              if (!("type" in element)) {
                throw new TypeError("Cannot encode array of PemStruct in PEM format. Not all items of the array are PemStrut");
              }
              raws.push(this.encodeStruct(element));
            });
          }
          return raws.join("\n");
        } else {
          if (!tag) {
            throw new Error("Required argument 'tag' is missed");
          }
          return this.encodeStruct({
            type: tag,
            rawData: pvtsutils.BufferSourceConverter.toArrayBuffer(rawData)
          });
        }
      }
      static encodeStruct(pem) {
        var _a2;
        const upperCaseType = pem.type.toLocaleUpperCase();
        const res = [];
        res.push(`-----BEGIN ${upperCaseType}-----`);
        if ((_a2 = pem.headers) === null || _a2 === void 0 ? void 0 : _a2.length) {
          for (const header of pem.headers) {
            res.push(`${header.key}: ${header.value}`);
          }
          res.push("");
        }
        const base64 = pvtsutils.Convert.ToBase64(pem.rawData);
        for (let i = 0; i < base64.length; i += 64) {
          res.push(base64.substring(i, i + 64));
        }
        res.push(`-----END ${upperCaseType}-----`);
        return res.join("\n");
      }
    };
    PemConverter.CertificateTag = "CERTIFICATE";
    PemConverter.CrlTag = "CRL";
    PemConverter.CertificateRequestTag = "CERTIFICATE REQUEST";
    PemConverter.PublicKeyTag = "PUBLIC KEY";
    PemConverter.PrivateKeyTag = "PRIVATE KEY";
    var PemData = class _PemData extends AsnData {
      static isAsnEncoded(data) {
        return pvtsutils.BufferSourceConverter.isBufferSource(data) || typeof data === "string";
      }
      static toArrayBuffer(raw) {
        if (typeof raw === "string") {
          if (PemConverter.isPem(raw)) {
            return PemConverter.decode(raw)[0];
          } else if (pvtsutils.Convert.isHex(raw)) {
            return pvtsutils.Convert.FromHex(raw);
          } else if (pvtsutils.Convert.isBase64(raw)) {
            return pvtsutils.Convert.FromBase64(raw);
          } else if (pvtsutils.Convert.isBase64Url(raw)) {
            return pvtsutils.Convert.FromBase64Url(raw);
          } else {
            throw new TypeError("Unsupported format of 'raw' argument. Must be one of DER, PEM, HEX, Base64, or Base4Url");
          }
        } else {
          const buffer = pvtsutils.BufferSourceConverter.toUint8Array(raw);
          if (buffer.length > 0 && buffer[0] === 48) {
            return pvtsutils.BufferSourceConverter.toArrayBuffer(raw);
          }
          const stringRaw = pvtsutils.Convert.ToBinary(raw);
          if (PemConverter.isPem(stringRaw)) {
            return PemConverter.decode(stringRaw)[0];
          } else if (pvtsutils.Convert.isHex(stringRaw)) {
            return pvtsutils.Convert.FromHex(stringRaw);
          } else if (pvtsutils.Convert.isBase64(stringRaw)) {
            return pvtsutils.Convert.FromBase64(stringRaw);
          } else if (pvtsutils.Convert.isBase64Url(stringRaw)) {
            return pvtsutils.Convert.FromBase64Url(stringRaw);
          }
          throw new TypeError("Unsupported format of 'raw' argument. Must be one of DER, PEM, HEX, Base64, or Base4Url");
        }
      }
      constructor(...args) {
        if (_PemData.isAsnEncoded(args[0])) {
          super(_PemData.toArrayBuffer(args[0]), args[1], args[2]);
        } else {
          super(args[0], args[1]);
        }
      }
      toString(format = "pem") {
        switch (format) {
          case "pem":
            return PemConverter.encode(this.rawData, this.tag);
          default:
            return super.toString(format);
        }
      }
    };
    var PublicKey = class _PublicKey extends PemData {
      static async create(data, crypto2 = cryptoProvider.get()) {
        if (data instanceof _PublicKey) {
          return data;
        } else if (CryptoProvider.isCryptoKey(data)) {
          if (data.type !== "public") {
            throw new TypeError("Public key is required");
          }
          const spki = await crypto2.subtle.exportKey("spki", data);
          return new _PublicKey(spki);
        } else if (data.publicKey) {
          return data.publicKey;
        } else if (pvtsutils.BufferSourceConverter.isBufferSource(data)) {
          return new _PublicKey(data);
        } else {
          throw new TypeError("Unsupported PublicKeyType");
        }
      }
      constructor(param, options) {
        if (PemData.isAsnEncoded(param)) {
          super(param, asn1X509.SubjectPublicKeyInfo, options);
        } else {
          super(param, options);
        }
        this.tag = PemConverter.PublicKeyTag;
      }
      async export(arg1, arg2, arg3) {
        let crypto2;
        let keyUsages = ["verify"];
        let algorithm = {
          hash: "SHA-256",
          ...this.algorithm
        };
        if (arg2) {
          algorithm = arg1;
          keyUsages = arg2;
          crypto2 = arg3;
        } else {
          crypto2 = arg1;
        }
        crypto2 !== null && crypto2 !== void 0 ? crypto2 : crypto2 = cryptoProvider.get();
        let raw = this.rawData;
        const asnSpki = asn1Schema.AsnConvert.parse(this.rawData, asn1X509.SubjectPublicKeyInfo, this.parseOptions);
        if (asnSpki.algorithm.algorithm === asn1Rsa.id_RSASSA_PSS) {
          raw = convertSpkiToRsaPkcs1(asnSpki, raw);
        }
        return crypto2.subtle.importKey("spki", raw, algorithm, true, keyUsages);
      }
      onInit(asn) {
        const algProv = tsyringe.container.resolve(diAlgorithmProvider);
        const algorithm = this.algorithm = algProv.toWebAlgorithm(asn.algorithm);
        switch (asn.algorithm.algorithm) {
          case asn1Rsa.id_rsaEncryption: {
            const rsaPublicKey = asn1Schema.AsnConvert.parse(asn.subjectPublicKey, asn1Rsa.RSAPublicKey, this.parseOptions);
            const modulus = pvtsutils.BufferSourceConverter.toUint8Array(rsaPublicKey.modulus);
            algorithm.publicExponent = pvtsutils.BufferSourceConverter.toUint8Array(rsaPublicKey.publicExponent);
            algorithm.modulusLength = (!modulus[0] ? modulus.slice(1) : modulus).byteLength << 3;
            break;
          }
        }
      }
      async getThumbprint(arg1, arg2) {
        let crypto2;
        let algorithm = "SHA-1";
        if (arg1) {
          if (typeof arg1 === "object" && "subtle" in arg1) {
            crypto2 = arg1;
          } else {
            algorithm = arg1;
            crypto2 = arg2;
          }
        }
        crypto2 !== null && crypto2 !== void 0 ? crypto2 : crypto2 = cryptoProvider.get();
        return await crypto2.subtle.digest(algorithm, this.rawData);
      }
      async getKeyIdentifier(arg1, arg2) {
        let crypto2;
        let algorithm = "SHA-1";
        if (arg1) {
          if (typeof arg1 === "object" && "subtle" in arg1) {
            crypto2 = arg1;
          } else {
            algorithm = arg1;
            crypto2 = arg2;
          }
        }
        crypto2 !== null && crypto2 !== void 0 ? crypto2 : crypto2 = cryptoProvider.get();
        const asn = asn1Schema.AsnConvert.parse(this.rawData, asn1X509.SubjectPublicKeyInfo, this.parseOptions);
        return await crypto2.subtle.digest(algorithm, asn.subjectPublicKey);
      }
      toTextObject() {
        const obj = this.toTextObjectEmpty();
        const asn = asn1Schema.AsnConvert.parse(this.rawData, asn1X509.SubjectPublicKeyInfo, this.parseOptions);
        obj["Algorithm"] = TextConverter.serializeAlgorithm(asn.algorithm);
        switch (asn.algorithm.algorithm) {
          case asn1Ecc.id_ecPublicKey:
            obj["EC Point"] = asn.subjectPublicKey;
            break;
          case asn1Rsa.id_rsaEncryption:
          default:
            obj["Raw Data"] = asn.subjectPublicKey;
        }
        return obj;
      }
    };
    function convertSpkiToRsaPkcs1(asnSpki, raw) {
      asnSpki.algorithm = new asn1X509.AlgorithmIdentifier({
        algorithm: asn1Rsa.id_rsaEncryption,
        parameters: null
      });
      raw = asn1Schema.AsnConvert.serialize(asnSpki);
      return raw;
    }
    var AuthorityKeyIdentifierExtension = class _AuthorityKeyIdentifierExtension extends Extension {
      static async create(param, critical = false, crypto2 = cryptoProvider.get()) {
        if ("name" in param && "serialNumber" in param) {
          return new _AuthorityKeyIdentifierExtension(param, critical);
        }
        const key = await PublicKey.create(param, crypto2);
        const id2 = await key.getKeyIdentifier(crypto2);
        return new _AuthorityKeyIdentifierExtension(pvtsutils.Convert.ToHex(id2), critical);
      }
      constructor(...args) {
        if (pvtsutils.BufferSourceConverter.isBufferSource(args[0])) {
          super(args[0], args[1]);
        } else if (typeof args[0] === "string") {
          const value = new asn1X509__namespace.AuthorityKeyIdentifier({
            keyIdentifier: new asn1X509__namespace.KeyIdentifier(pvtsutils.Convert.FromHex(args[0]))
          });
          super(asn1X509__namespace.id_ce_authorityKeyIdentifier, args[1], asn1Schema.AsnConvert.serialize(value));
        } else {
          const certId = args[0];
          const certIdName = certId.name instanceof GeneralNames ? asn1Schema.AsnConvert.parse(certId.name.rawData, asn1X509__namespace.GeneralNames) : certId.name;
          const value = new asn1X509__namespace.AuthorityKeyIdentifier({
            authorityCertIssuer: certIdName,
            authorityCertSerialNumber: pvtsutils.Convert.FromHex(certId.serialNumber)
          });
          super(asn1X509__namespace.id_ce_authorityKeyIdentifier, args[1], asn1Schema.AsnConvert.serialize(value));
        }
      }
      onInit(asn) {
        super.onInit(asn);
        const aki = asn1Schema.AsnConvert.parse(asn.extnValue, asn1X509__namespace.AuthorityKeyIdentifier, this.parseOptions);
        if (aki.keyIdentifier) {
          this.keyId = pvtsutils.Convert.ToHex(aki.keyIdentifier);
        }
        if (aki.authorityCertIssuer || aki.authorityCertSerialNumber) {
          this.certId = {
            name: aki.authorityCertIssuer || [],
            serialNumber: aki.authorityCertSerialNumber ? pvtsutils.Convert.ToHex(aki.authorityCertSerialNumber) : ""
          };
        }
      }
      toTextObject() {
        const obj = this.toTextObjectWithoutValue();
        const asn = asn1Schema.AsnConvert.parse(this.value, asn1X509__namespace.AuthorityKeyIdentifier, this.parseOptions);
        if (asn.authorityCertIssuer) {
          obj["Authority Issuer"] = new GeneralNames(asn.authorityCertIssuer).toTextObject();
        }
        if (asn.authorityCertSerialNumber) {
          obj["Authority Serial Number"] = asn.authorityCertSerialNumber;
        }
        if (asn.keyIdentifier) {
          obj[""] = asn.keyIdentifier;
        }
        return obj;
      }
    };
    AuthorityKeyIdentifierExtension.NAME = "Authority Key Identifier";
    var BasicConstraintsExtension2 = class extends Extension {
      constructor(...args) {
        if (pvtsutils.BufferSourceConverter.isBufferSource(args[0])) {
          super(args[0], args[1]);
          const value = asn1Schema.AsnConvert.parse(this.value, asn1X509.BasicConstraints, this.parseOptions);
          this.ca = value.cA;
          this.pathLength = value.pathLenConstraint;
        } else {
          const value = new asn1X509.BasicConstraints({
            cA: args[0],
            pathLenConstraint: args[1]
          });
          super(asn1X509.id_ce_basicConstraints, args[2], asn1Schema.AsnConvert.serialize(value));
          this.ca = args[0];
          this.pathLength = args[1];
        }
      }
      toTextObject() {
        const obj = this.toTextObjectWithoutValue();
        if (this.ca) {
          obj["CA"] = this.ca;
        }
        if (this.pathLength !== void 0) {
          obj["Path Length"] = this.pathLength;
        }
        return obj;
      }
    };
    BasicConstraintsExtension2.NAME = "Basic Constraints";
    exports.ExtendedKeyUsage = void 0;
    (function(ExtendedKeyUsage) {
      ExtendedKeyUsage["serverAuth"] = "1.3.6.1.5.5.7.3.1";
      ExtendedKeyUsage["clientAuth"] = "1.3.6.1.5.5.7.3.2";
      ExtendedKeyUsage["codeSigning"] = "1.3.6.1.5.5.7.3.3";
      ExtendedKeyUsage["emailProtection"] = "1.3.6.1.5.5.7.3.4";
      ExtendedKeyUsage["timeStamping"] = "1.3.6.1.5.5.7.3.8";
      ExtendedKeyUsage["ocspSigning"] = "1.3.6.1.5.5.7.3.9";
    })(exports.ExtendedKeyUsage || (exports.ExtendedKeyUsage = {}));
    var ExtendedKeyUsageExtension2 = class extends Extension {
      constructor(...args) {
        if (pvtsutils.BufferSourceConverter.isBufferSource(args[0])) {
          super(args[0], args[1]);
          const value = asn1Schema.AsnConvert.parse(this.value, asn1X509__namespace.ExtendedKeyUsage, this.parseOptions);
          this.usages = value.map((o) => o);
        } else {
          const value = new asn1X509__namespace.ExtendedKeyUsage(args[0]);
          super(asn1X509__namespace.id_ce_extKeyUsage, args[1], asn1Schema.AsnConvert.serialize(value));
          this.usages = args[0];
        }
      }
      toTextObject() {
        const obj = this.toTextObjectWithoutValue();
        obj[""] = this.usages.map((o) => OidSerializer.toString(o)).join(", ");
        return obj;
      }
    };
    ExtendedKeyUsageExtension2.NAME = "Extended Key Usages";
    exports.KeyUsageFlags = void 0;
    (function(KeyUsageFlags2) {
      KeyUsageFlags2[KeyUsageFlags2["digitalSignature"] = 1] = "digitalSignature";
      KeyUsageFlags2[KeyUsageFlags2["nonRepudiation"] = 2] = "nonRepudiation";
      KeyUsageFlags2[KeyUsageFlags2["keyEncipherment"] = 4] = "keyEncipherment";
      KeyUsageFlags2[KeyUsageFlags2["dataEncipherment"] = 8] = "dataEncipherment";
      KeyUsageFlags2[KeyUsageFlags2["keyAgreement"] = 16] = "keyAgreement";
      KeyUsageFlags2[KeyUsageFlags2["keyCertSign"] = 32] = "keyCertSign";
      KeyUsageFlags2[KeyUsageFlags2["cRLSign"] = 64] = "cRLSign";
      KeyUsageFlags2[KeyUsageFlags2["encipherOnly"] = 128] = "encipherOnly";
      KeyUsageFlags2[KeyUsageFlags2["decipherOnly"] = 256] = "decipherOnly";
    })(exports.KeyUsageFlags || (exports.KeyUsageFlags = {}));
    var KeyUsagesExtension2 = class extends Extension {
      constructor(...args) {
        if (pvtsutils.BufferSourceConverter.isBufferSource(args[0])) {
          super(args[0], args[1]);
          const value = asn1Schema.AsnConvert.parse(this.value, asn1X509.KeyUsage, this.parseOptions);
          this.usages = value.toNumber();
        } else {
          const value = new asn1X509.KeyUsage(args[0]);
          super(asn1X509.id_ce_keyUsage, args[1], asn1Schema.AsnConvert.serialize(value));
          this.usages = args[0];
        }
      }
      toTextObject() {
        const obj = this.toTextObjectWithoutValue();
        const asn = asn1Schema.AsnConvert.parse(this.value, asn1X509.KeyUsage, this.parseOptions);
        obj[""] = asn.toJSON().join(", ");
        return obj;
      }
    };
    KeyUsagesExtension2.NAME = "Key Usages";
    var SubjectKeyIdentifierExtension = class _SubjectKeyIdentifierExtension extends Extension {
      static async create(publicKey, critical = false, crypto2 = cryptoProvider.get()) {
        const key = await PublicKey.create(publicKey, crypto2);
        const id2 = await key.getKeyIdentifier(crypto2);
        return new _SubjectKeyIdentifierExtension(pvtsutils.Convert.ToHex(id2), critical);
      }
      constructor(...args) {
        if (pvtsutils.BufferSourceConverter.isBufferSource(args[0])) {
          super(args[0], args[1]);
          const value = asn1Schema.AsnConvert.parse(this.value, asn1X509__namespace.SubjectKeyIdentifier, this.parseOptions);
          this.keyId = pvtsutils.Convert.ToHex(value);
        } else {
          const identifier = typeof args[0] === "string" ? pvtsutils.Convert.FromHex(args[0]) : args[0];
          const value = new asn1X509__namespace.SubjectKeyIdentifier(identifier);
          super(asn1X509__namespace.id_ce_subjectKeyIdentifier, args[1], asn1Schema.AsnConvert.serialize(value));
          this.keyId = pvtsutils.Convert.ToHex(identifier);
        }
      }
      toTextObject() {
        const obj = this.toTextObjectWithoutValue();
        const asn = asn1Schema.AsnConvert.parse(this.value, asn1X509__namespace.SubjectKeyIdentifier, this.parseOptions);
        obj[""] = asn;
        return obj;
      }
    };
    SubjectKeyIdentifierExtension.NAME = "Subject Key Identifier";
    var SubjectAlternativeNameExtension2 = class extends Extension {
      constructor(...args) {
        if (pvtsutils.BufferSourceConverter.isBufferSource(args[0])) {
          super(args[0], args[1]);
        } else {
          super(asn1X509__namespace.id_ce_subjectAltName, args[1], new GeneralNames(args[0] || []).rawData);
        }
      }
      onInit(asn) {
        super.onInit(asn);
        const value = asn1Schema.AsnConvert.parse(asn.extnValue, asn1X509__namespace.SubjectAlternativeName, this.parseOptions);
        this.names = new GeneralNames(value);
      }
      toTextObject() {
        const obj = this.toTextObjectWithoutValue();
        const namesObj = this.names.toTextObject();
        for (const key in namesObj) {
          obj[key] = namesObj[key];
        }
        return obj;
      }
    };
    SubjectAlternativeNameExtension2.NAME = "Subject Alternative Name";
    var ExtensionFactory = class {
      static register(id2, type) {
        this.items.set(id2, type);
      }
      static create(data, options) {
        const extension = new Extension(data, options);
        const Type = this.items.get(extension.type);
        if (Type) {
          return new Type(data, options);
        }
        return extension;
      }
    };
    ExtensionFactory.items = /* @__PURE__ */ new Map();
    var CertificatePolicyExtension = class extends Extension {
      constructor(...args) {
        var _a2;
        if (pvtsutils.BufferSourceConverter.isBufferSource(args[0])) {
          super(args[0], args[1]);
          const asnPolicies = asn1Schema.AsnConvert.parse(this.value, asn1X509__namespace.CertificatePolicies, this.parseOptions);
          this.policies = asnPolicies.map((o) => o.policyIdentifier);
        } else {
          const policies = args[0];
          const critical = (_a2 = args[1]) !== null && _a2 !== void 0 ? _a2 : false;
          const value = new asn1X509__namespace.CertificatePolicies(policies.map((o) => new asn1X509__namespace.PolicyInformation({ policyIdentifier: o })));
          super(asn1X509__namespace.id_ce_certificatePolicies, critical, asn1Schema.AsnConvert.serialize(value));
          this.policies = policies;
        }
      }
      toTextObject() {
        const obj = this.toTextObjectWithoutValue();
        obj["Policy"] = this.policies.map((o) => new TextObject("", {}, OidSerializer.toString(o)));
        return obj;
      }
    };
    CertificatePolicyExtension.NAME = "Certificate Policies";
    ExtensionFactory.register(asn1X509__namespace.id_ce_certificatePolicies, CertificatePolicyExtension);
    var CRLDistributionPointsExtension = class extends Extension {
      constructor(...args) {
        var _a2;
        if (pvtsutils.BufferSourceConverter.isBufferSource(args[0])) {
          super(args[0], args[1]);
        } else if (Array.isArray(args[0]) && typeof args[0][0] === "string") {
          const urls = args[0];
          const dps = urls.map((url) => {
            return new asn1X509__namespace.DistributionPoint({
              distributionPoint: new asn1X509__namespace.DistributionPointName({
                fullName: [new asn1X509__namespace.GeneralName({ uniformResourceIdentifier: url })]
              })
            });
          });
          const value = new asn1X509__namespace.CRLDistributionPoints(dps);
          super(asn1X509__namespace.id_ce_cRLDistributionPoints, args[1], asn1Schema.AsnConvert.serialize(value));
        } else {
          const value = new asn1X509__namespace.CRLDistributionPoints(args[0]);
          super(asn1X509__namespace.id_ce_cRLDistributionPoints, args[1], asn1Schema.AsnConvert.serialize(value));
        }
        (_a2 = this.distributionPoints) !== null && _a2 !== void 0 ? _a2 : this.distributionPoints = [];
      }
      onInit(asn) {
        super.onInit(asn);
        const crlExt = asn1Schema.AsnConvert.parse(asn.extnValue, asn1X509__namespace.CRLDistributionPoints, this.parseOptions);
        this.distributionPoints = crlExt;
      }
      toTextObject() {
        const obj = this.toTextObjectWithoutValue();
        obj["Distribution Point"] = this.distributionPoints.map((dp) => {
          var _a2;
          const dpObj = new TextObject("");
          if ((_a2 = dp.distributionPoint) === null || _a2 === void 0 ? void 0 : _a2.fullName) {
            dpObj[""] = dp.distributionPoint.fullName.map((name) => new GeneralName(name).toString()).join(", ");
          }
          if (dp.reasons) {
            dpObj["Reasons"] = dp.reasons.toString();
          }
          if (dp.cRLIssuer) {
            dpObj["CRL Issuer"] = dp.cRLIssuer.map((issuer) => issuer.toString()).join(", ");
          }
          return dpObj;
        });
        return obj;
      }
    };
    CRLDistributionPointsExtension.NAME = "CRL Distribution Points";
    var AuthorityInfoAccessExtension = class extends Extension {
      constructor(...args) {
        var _a2, _b, _c, _d;
        if (pvtsutils.BufferSourceConverter.isBufferSource(args[0])) {
          super(args[0], args[1]);
        } else if (args[0] instanceof asn1X509__namespace.AuthorityInfoAccessSyntax) {
          const value = new asn1X509__namespace.AuthorityInfoAccessSyntax(args[0]);
          super(asn1X509__namespace.id_pe_authorityInfoAccess, args[1], asn1Schema.AsnConvert.serialize(value));
        } else {
          const params = args[0];
          const value = new asn1X509__namespace.AuthorityInfoAccessSyntax();
          addAccessDescriptions(value, params, asn1X509__namespace.id_ad_ocsp, "ocsp");
          addAccessDescriptions(value, params, asn1X509__namespace.id_ad_caIssuers, "caIssuers");
          addAccessDescriptions(value, params, asn1X509__namespace.id_ad_timeStamping, "timeStamping");
          addAccessDescriptions(value, params, asn1X509__namespace.id_ad_caRepository, "caRepository");
          super(asn1X509__namespace.id_pe_authorityInfoAccess, args[1], asn1Schema.AsnConvert.serialize(value));
        }
        (_a2 = this.ocsp) !== null && _a2 !== void 0 ? _a2 : this.ocsp = [];
        (_b = this.caIssuers) !== null && _b !== void 0 ? _b : this.caIssuers = [];
        (_c = this.timeStamping) !== null && _c !== void 0 ? _c : this.timeStamping = [];
        (_d = this.caRepository) !== null && _d !== void 0 ? _d : this.caRepository = [];
      }
      onInit(asn) {
        super.onInit(asn);
        this.ocsp = [];
        this.caIssuers = [];
        this.timeStamping = [];
        this.caRepository = [];
        const aia = asn1Schema.AsnConvert.parse(asn.extnValue, asn1X509__namespace.AuthorityInfoAccessSyntax, this.parseOptions);
        aia.forEach((accessDescription) => {
          switch (accessDescription.accessMethod) {
            case asn1X509__namespace.id_ad_ocsp:
              this.ocsp.push(new GeneralName(accessDescription.accessLocation));
              break;
            case asn1X509__namespace.id_ad_caIssuers:
              this.caIssuers.push(new GeneralName(accessDescription.accessLocation));
              break;
            case asn1X509__namespace.id_ad_timeStamping:
              this.timeStamping.push(new GeneralName(accessDescription.accessLocation));
              break;
            case asn1X509__namespace.id_ad_caRepository:
              this.caRepository.push(new GeneralName(accessDescription.accessLocation));
              break;
          }
        });
      }
      toTextObject() {
        const obj = this.toTextObjectWithoutValue();
        if (this.ocsp.length) {
          addUrlsToObject(obj, "OCSP", this.ocsp);
        }
        if (this.caIssuers.length) {
          addUrlsToObject(obj, "CA Issuers", this.caIssuers);
        }
        if (this.timeStamping.length) {
          addUrlsToObject(obj, "Time Stamping", this.timeStamping);
        }
        if (this.caRepository.length) {
          addUrlsToObject(obj, "CA Repository", this.caRepository);
        }
        return obj;
      }
    };
    AuthorityInfoAccessExtension.NAME = "Authority Info Access";
    function addUrlsToObject(obj, key, urls) {
      if (urls.length === 1) {
        obj[key] = urls[0].toTextObject();
      } else {
        const names2 = new TextObject("");
        urls.forEach((name, index) => {
          const nameObj = name.toTextObject();
          const indexedKey = `${nameObj[TextObject.NAME]} ${index + 1}`;
          let field = names2[indexedKey];
          if (!Array.isArray(field)) {
            field = [];
            names2[indexedKey] = field;
          }
          field.push(nameObj);
        });
        obj[key] = names2;
      }
    }
    function addAccessDescriptions(value, params, method, key) {
      const items = params[key];
      if (items) {
        const array = Array.isArray(items) ? items : [items];
        array.forEach((url) => {
          if (typeof url === "string") {
            url = new GeneralName("url", url);
          }
          value.push(new asn1X509__namespace.AccessDescription({
            accessMethod: method,
            accessLocation: asn1Schema.AsnConvert.parse(url.rawData, asn1X509__namespace.GeneralName)
          }));
        });
      }
    }
    var IssuerAlternativeNameExtension = class extends Extension {
      constructor(...args) {
        if (pvtsutils.BufferSourceConverter.isBufferSource(args[0])) {
          super(args[0], args[1]);
        } else {
          super(asn1X509__namespace.id_ce_issuerAltName, args[1], new GeneralNames(args[0] || []).rawData);
        }
      }
      onInit(asn) {
        super.onInit(asn);
        const value = asn1Schema.AsnConvert.parse(asn.extnValue, asn1X509__namespace.GeneralNames, this.parseOptions);
        this.names = new GeneralNames(value);
      }
      toTextObject() {
        const obj = this.toTextObjectWithoutValue();
        const namesObj = this.names.toTextObject();
        for (const key in namesObj) {
          obj[key] = namesObj[key];
        }
        return obj;
      }
    };
    IssuerAlternativeNameExtension.NAME = "Issuer Alternative Name";
    var Attribute = class _Attribute extends AsnData {
      constructor(...args) {
        let raw;
        let options;
        if (pvtsutils.BufferSourceConverter.isBufferSource(args[0])) {
          raw = pvtsutils.BufferSourceConverter.toArrayBuffer(args[0]);
          options = args[1];
        } else {
          const type = args[0];
          const values = Array.isArray(args[1]) ? args[1].map((o) => pvtsutils.BufferSourceConverter.toArrayBuffer(o)) : [];
          raw = asn1Schema.AsnConvert.serialize(new asn1X509.Attribute({
            type,
            values
          }));
        }
        super(raw, asn1X509.Attribute, options);
      }
      onInit(asn) {
        this.type = asn.type;
        this.values = asn.values;
      }
      toTextObject() {
        const obj = this.toTextObjectWithoutValue();
        obj["Value"] = this.values.map((o) => new TextObject("", { "": o }));
        return obj;
      }
      toTextObjectWithoutValue() {
        const obj = this.toTextObjectEmpty();
        if (obj[TextObject.NAME] === _Attribute.NAME) {
          obj[TextObject.NAME] = OidSerializer.toString(this.type);
        }
        return obj;
      }
    };
    Attribute.NAME = "Attribute";
    var ChallengePasswordAttribute = class extends Attribute {
      constructor(...args) {
        var _a2;
        if (pvtsutils.BufferSourceConverter.isBufferSource(args[0])) {
          super(args[0], args[1]);
        } else {
          const value = new asnPkcs9__namespace.ChallengePassword({ printableString: args[0] });
          super(asnPkcs9__namespace.id_pkcs9_at_challengePassword, [asn1Schema.AsnConvert.serialize(value)]);
        }
        (_a2 = this.password) !== null && _a2 !== void 0 ? _a2 : this.password = "";
      }
      onInit(asn) {
        super.onInit(asn);
        if (this.values[0]) {
          const value = asn1Schema.AsnConvert.parse(this.values[0], asnPkcs9__namespace.ChallengePassword, this.parseOptions);
          this.password = value.toString();
        }
      }
      toTextObject() {
        const obj = this.toTextObjectWithoutValue();
        obj[TextObject.VALUE] = this.password;
        return obj;
      }
    };
    ChallengePasswordAttribute.NAME = "Challenge Password";
    var ExtensionsAttribute = class extends Attribute {
      constructor(...args) {
        var _a2;
        if (pvtsutils.BufferSourceConverter.isBufferSource(args[0])) {
          super(args[0], args[1]);
        } else {
          const extensions = args[0];
          const value = new asn1X509__namespace.Extensions();
          for (const extension of extensions) {
            value.push(asn1Schema.AsnConvert.parse(extension.rawData, asn1X509__namespace.Extension));
          }
          super(asnPkcs9__namespace.id_pkcs9_at_extensionRequest, [asn1Schema.AsnConvert.serialize(value)]);
        }
        (_a2 = this.items) !== null && _a2 !== void 0 ? _a2 : this.items = [];
      }
      onInit(asn) {
        super.onInit(asn);
        if (this.values[0]) {
          const value = asn1Schema.AsnConvert.parse(this.values[0], asn1X509__namespace.Extensions, this.parseOptions);
          this.items = value.map((o) => ExtensionFactory.create(asn1Schema.AsnConvert.serialize(o), this.parseOptions));
        }
      }
      toTextObject() {
        const obj = this.toTextObjectWithoutValue();
        const extensions = this.items.map((o) => o.toTextObject());
        for (const extension of extensions) {
          obj[extension[TextObject.NAME]] = extension;
        }
        return obj;
      }
    };
    ExtensionsAttribute.NAME = "Extensions";
    var AttributeFactory = class {
      static register(id2, type) {
        this.items.set(id2, type);
      }
      static create(data, options) {
        const attribute = new Attribute(data, options);
        const Type = this.items.get(attribute.type);
        if (Type) {
          return new Type(data, options);
        }
        return attribute;
      }
    };
    AttributeFactory.items = /* @__PURE__ */ new Map();
    var diAsnSignatureFormatter = "crypto.signatureFormatter";
    var AsnDefaultSignatureFormatter = class {
      toAsnSignature(algorithm, signature) {
        return pvtsutils.BufferSourceConverter.toArrayBuffer(signature);
      }
      toWebSignature(algorithm, signature) {
        return pvtsutils.BufferSourceConverter.toArrayBuffer(signature);
      }
    };
    var RsaAlgorithm_1;
    exports.RsaAlgorithm = RsaAlgorithm_1 = class RsaAlgorithm {
      static createPssParams(hash, saltLength) {
        const hashAlgorithm = RsaAlgorithm_1.getHashAlgorithm(hash);
        if (!hashAlgorithm) {
          return null;
        }
        return new asn1Rsa__namespace.RsaSaPssParams({
          hashAlgorithm,
          maskGenAlgorithm: new asn1X509.AlgorithmIdentifier({
            algorithm: asn1Rsa__namespace.id_mgf1,
            parameters: asn1Schema.AsnConvert.serialize(hashAlgorithm)
          }),
          saltLength
        });
      }
      static getHashAlgorithm(alg) {
        const algProv = tsyringe.container.resolve(diAlgorithmProvider);
        if (typeof alg === "string") {
          return algProv.toAsnAlgorithm({ name: alg });
        }
        if (typeof alg === "object" && alg && "name" in alg) {
          return algProv.toAsnAlgorithm(alg);
        }
        return null;
      }
      toAsnAlgorithm(alg) {
        switch (alg.name.toLowerCase()) {
          case "rsassa-pkcs1-v1_5":
            if ("hash" in alg) {
              let hash;
              if (typeof alg.hash === "string") {
                hash = alg.hash;
              } else if (alg.hash && typeof alg.hash === "object" && "name" in alg.hash && typeof alg.hash.name === "string") {
                hash = alg.hash.name.toUpperCase();
              } else {
                throw new Error("Cannot get hash algorithm name");
              }
              switch (hash.toLowerCase()) {
                case "sha-1":
                  return new asn1X509.AlgorithmIdentifier({
                    algorithm: asn1Rsa__namespace.id_sha1WithRSAEncryption,
                    parameters: null
                  });
                case "sha-256":
                  return new asn1X509.AlgorithmIdentifier({
                    algorithm: asn1Rsa__namespace.id_sha256WithRSAEncryption,
                    parameters: null
                  });
                case "sha-384":
                  return new asn1X509.AlgorithmIdentifier({
                    algorithm: asn1Rsa__namespace.id_sha384WithRSAEncryption,
                    parameters: null
                  });
                case "sha-512":
                  return new asn1X509.AlgorithmIdentifier({
                    algorithm: asn1Rsa__namespace.id_sha512WithRSAEncryption,
                    parameters: null
                  });
              }
            } else {
              return new asn1X509.AlgorithmIdentifier({
                algorithm: asn1Rsa__namespace.id_rsaEncryption,
                parameters: null
              });
            }
            break;
          case "rsa-pss":
            if ("hash" in alg) {
              if (!("saltLength" in alg && typeof alg.saltLength === "number")) {
                throw new Error("Cannot get 'saltLength' from 'alg' argument");
              }
              const pssParams = RsaAlgorithm_1.createPssParams(alg.hash, alg.saltLength);
              if (!pssParams) {
                throw new Error("Cannot create PSS parameters");
              }
              return new asn1X509.AlgorithmIdentifier({
                algorithm: asn1Rsa__namespace.id_RSASSA_PSS,
                parameters: asn1Schema.AsnConvert.serialize(pssParams)
              });
            } else {
              return new asn1X509.AlgorithmIdentifier({
                algorithm: asn1Rsa__namespace.id_RSASSA_PSS,
                parameters: null
              });
            }
        }
        return null;
      }
      toWebAlgorithm(alg) {
        switch (alg.algorithm) {
          case asn1Rsa__namespace.id_rsaEncryption:
            return { name: "RSASSA-PKCS1-v1_5" };
          case asn1Rsa__namespace.id_sha1WithRSAEncryption:
            return {
              name: "RSASSA-PKCS1-v1_5",
              hash: { name: "SHA-1" }
            };
          case asn1Rsa__namespace.id_sha256WithRSAEncryption:
            return {
              name: "RSASSA-PKCS1-v1_5",
              hash: { name: "SHA-256" }
            };
          case asn1Rsa__namespace.id_sha384WithRSAEncryption:
            return {
              name: "RSASSA-PKCS1-v1_5",
              hash: { name: "SHA-384" }
            };
          case asn1Rsa__namespace.id_sha512WithRSAEncryption:
            return {
              name: "RSASSA-PKCS1-v1_5",
              hash: { name: "SHA-512" }
            };
          case asn1Rsa__namespace.id_RSASSA_PSS:
            if (alg.parameters) {
              const pssParams = asn1Schema.AsnConvert.parse(alg.parameters, asn1Rsa__namespace.RsaSaPssParams);
              const algProv = tsyringe.container.resolve(diAlgorithmProvider);
              const hashAlg = algProv.toWebAlgorithm(pssParams.hashAlgorithm);
              return {
                name: "RSA-PSS",
                hash: hashAlg,
                saltLength: pssParams.saltLength
              };
            } else {
              return { name: "RSA-PSS" };
            }
        }
        return null;
      }
    };
    exports.RsaAlgorithm = RsaAlgorithm_1 = tslib.__decorate([
      tsyringe.injectable()
    ], exports.RsaAlgorithm);
    tsyringe.container.registerSingleton(diAlgorithm, exports.RsaAlgorithm);
    exports.ShaAlgorithm = class ShaAlgorithm {
      toAsnAlgorithm(alg) {
        switch (alg.name.toLowerCase()) {
          case "sha-1":
            return new asn1X509.AlgorithmIdentifier({ algorithm: asn1Rsa.id_sha1 });
          case "sha-256":
            return new asn1X509.AlgorithmIdentifier({ algorithm: asn1Rsa.id_sha256 });
          case "sha-384":
            return new asn1X509.AlgorithmIdentifier({ algorithm: asn1Rsa.id_sha384 });
          case "sha-512":
            return new asn1X509.AlgorithmIdentifier({ algorithm: asn1Rsa.id_sha512 });
        }
        return null;
      }
      toWebAlgorithm(alg) {
        switch (alg.algorithm) {
          case asn1Rsa.id_sha1:
            return { name: "SHA-1" };
          case asn1Rsa.id_sha256:
            return { name: "SHA-256" };
          case asn1Rsa.id_sha384:
            return { name: "SHA-384" };
          case asn1Rsa.id_sha512:
            return { name: "SHA-512" };
        }
        return null;
      }
    };
    exports.ShaAlgorithm = tslib.__decorate([
      tsyringe.injectable()
    ], exports.ShaAlgorithm);
    tsyringe.container.registerSingleton(diAlgorithm, exports.ShaAlgorithm);
    var AsnEcSignatureFormatter = class _AsnEcSignatureFormatter {
      addPadding(pointSize, data) {
        const bytes = pvtsutils.BufferSourceConverter.toUint8Array(data);
        const res = new Uint8Array(pointSize);
        res.set(bytes, pointSize - bytes.length);
        return res.buffer;
      }
      removePadding(data, positive = false) {
        let bytes = pvtsutils.BufferSourceConverter.toUint8Array(data);
        for (let i = 0; i < bytes.length; i++) {
          if (!bytes[i]) {
            continue;
          }
          bytes = bytes.slice(i);
          break;
        }
        if (positive && bytes[0] > 127) {
          const result = new Uint8Array(bytes.length + 1);
          result.set(bytes, 1);
          return result.buffer;
        }
        return bytes.buffer;
      }
      toAsnSignature(algorithm, signature) {
        if (algorithm.name === "ECDSA") {
          const namedCurve = algorithm.namedCurve;
          const pointSize = _AsnEcSignatureFormatter.namedCurveSize.get(namedCurve) || _AsnEcSignatureFormatter.defaultNamedCurveSize;
          const ecSignature = new asn1Ecc.ECDSASigValue();
          const uint8Signature = pvtsutils.BufferSourceConverter.toUint8Array(signature);
          ecSignature.r = this.removePadding(uint8Signature.slice(0, pointSize), true);
          ecSignature.s = this.removePadding(uint8Signature.slice(pointSize, pointSize + pointSize), true);
          return asn1Schema.AsnConvert.serialize(ecSignature);
        }
        return null;
      }
      toWebSignature(algorithm, signature) {
        if (algorithm.name === "ECDSA") {
          const ecSigValue = asn1Schema.AsnConvert.parse(signature, asn1Ecc.ECDSASigValue);
          const namedCurve = algorithm.namedCurve;
          const pointSize = _AsnEcSignatureFormatter.namedCurveSize.get(namedCurve) || _AsnEcSignatureFormatter.defaultNamedCurveSize;
          const r = this.addPadding(pointSize, this.removePadding(ecSigValue.r));
          const s = this.addPadding(pointSize, this.removePadding(ecSigValue.s));
          return pvtsutils.combine(r, s);
        }
        return null;
      }
    };
    AsnEcSignatureFormatter.namedCurveSize = /* @__PURE__ */ new Map();
    AsnEcSignatureFormatter.defaultNamedCurveSize = 32;
    var idX25519 = "1.3.101.110";
    var idX448 = "1.3.101.111";
    var idEd25519 = "1.3.101.112";
    var idEd448 = "1.3.101.113";
    exports.EdAlgorithm = class EdAlgorithm {
      toAsnAlgorithm(alg) {
        let algorithm = null;
        switch (alg.name.toLowerCase()) {
          case "ed25519":
            algorithm = idEd25519;
            break;
          case "x25519":
            algorithm = idX25519;
            break;
          case "eddsa":
            switch (alg.namedCurve.toLowerCase()) {
              case "ed25519":
                algorithm = idEd25519;
                break;
              case "ed448":
                algorithm = idEd448;
                break;
            }
            break;
          case "ecdh-es":
            switch (alg.namedCurve.toLowerCase()) {
              case "x25519":
                algorithm = idX25519;
                break;
              case "x448":
                algorithm = idX448;
                break;
            }
        }
        if (algorithm) {
          return new asn1X509.AlgorithmIdentifier({ algorithm });
        }
        return null;
      }
      toWebAlgorithm(alg) {
        switch (alg.algorithm) {
          case idEd25519:
            return { name: "Ed25519" };
          case idEd448:
            return {
              name: "EdDSA",
              namedCurve: "Ed448"
            };
          case idX25519:
            return { name: "X25519" };
          case idX448:
            return {
              name: "ECDH-ES",
              namedCurve: "X448"
            };
        }
        return null;
      }
    };
    exports.EdAlgorithm = tslib.__decorate([
      tsyringe.injectable()
    ], exports.EdAlgorithm);
    tsyringe.container.registerSingleton(diAlgorithm, exports.EdAlgorithm);
    exports.MlDsaAlgorithm = class MlDsaAlgorithm {
      toAsnAlgorithm(alg) {
        let algorithm = null;
        switch (alg.name.toLowerCase()) {
          case "ml-dsa-44":
            algorithm = asn1X509PostQuantum.id_ml_dsa_44;
            break;
          case "ml-dsa-65":
            algorithm = asn1X509PostQuantum.id_ml_dsa_65;
            break;
          case "ml-dsa-87":
            algorithm = asn1X509PostQuantum.id_ml_dsa_87;
            break;
        }
        if (algorithm) {
          return new asn1X509.AlgorithmIdentifier({ algorithm });
        }
        return null;
      }
      toWebAlgorithm(alg) {
        switch (alg.algorithm) {
          case asn1X509PostQuantum.id_ml_dsa_44:
            return { name: "ML-DSA-44" };
          case asn1X509PostQuantum.id_ml_dsa_65:
            return { name: "ML-DSA-65" };
          case asn1X509PostQuantum.id_ml_dsa_87:
            return { name: "ML-DSA-87" };
        }
        return null;
      }
    };
    exports.MlDsaAlgorithm = tslib.__decorate([
      tsyringe.injectable()
    ], exports.MlDsaAlgorithm);
    tsyringe.container.registerSingleton(diAlgorithm, exports.MlDsaAlgorithm);
    exports.SlhDsaAlgorithm = class SlhDsaAlgorithm {
      toAsnAlgorithm(alg) {
        let algorithm = null;
        switch (alg.name.toLowerCase()) {
          case "slh-dsa-sha2-128s":
            algorithm = asn1X509PostQuantum.id_slh_dsa_sha2_128s;
            break;
          case "slh-dsa-sha2-128f":
            algorithm = asn1X509PostQuantum.id_slh_dsa_sha2_128f;
            break;
          case "slh-dsa-sha2-192s":
            algorithm = asn1X509PostQuantum.id_slh_dsa_sha2_192s;
            break;
          case "slh-dsa-sha2-192f":
            algorithm = asn1X509PostQuantum.id_slh_dsa_sha2_192f;
            break;
          case "slh-dsa-sha2-256s":
            algorithm = asn1X509PostQuantum.id_slh_dsa_sha2_256s;
            break;
          case "slh-dsa-sha2-256f":
            algorithm = asn1X509PostQuantum.id_slh_dsa_sha2_256f;
            break;
          case "slh-dsa-shake-128s":
            algorithm = asn1X509PostQuantum.id_slh_dsa_shake_128s;
            break;
          case "slh-dsa-shake-128f":
            algorithm = asn1X509PostQuantum.id_slh_dsa_shake_128f;
            break;
          case "slh-dsa-shake-192s":
            algorithm = asn1X509PostQuantum.id_slh_dsa_shake_192s;
            break;
          case "slh-dsa-shake-192f":
            algorithm = asn1X509PostQuantum.id_slh_dsa_shake_192f;
            break;
          case "slh-dsa-shake-256s":
            algorithm = asn1X509PostQuantum.id_slh_dsa_shake_256s;
            break;
          case "slh-dsa-shake-256f":
            algorithm = asn1X509PostQuantum.id_slh_dsa_shake_256f;
            break;
        }
        if (algorithm) {
          return new asn1X509.AlgorithmIdentifier({ algorithm });
        }
        return null;
      }
      toWebAlgorithm(alg) {
        switch (alg.algorithm) {
          case asn1X509PostQuantum.id_slh_dsa_sha2_128s:
            return { name: "SLH-DSA-SHA2-128s" };
          case asn1X509PostQuantum.id_slh_dsa_sha2_128f:
            return { name: "SLH-DSA-SHA2-128f" };
          case asn1X509PostQuantum.id_slh_dsa_sha2_192s:
            return { name: "SLH-DSA-SHA2-192s" };
          case asn1X509PostQuantum.id_slh_dsa_sha2_192f:
            return { name: "SLH-DSA-SHA2-192f" };
          case asn1X509PostQuantum.id_slh_dsa_sha2_256s:
            return { name: "SLH-DSA-SHA2-256s" };
          case asn1X509PostQuantum.id_slh_dsa_sha2_256f:
            return { name: "SLH-DSA-SHA2-256f" };
          case asn1X509PostQuantum.id_slh_dsa_shake_128s:
            return { name: "SLH-DSA-SHAKE-128s" };
          case asn1X509PostQuantum.id_slh_dsa_shake_128f:
            return { name: "SLH-DSA-SHAKE-128f" };
          case asn1X509PostQuantum.id_slh_dsa_shake_192s:
            return { name: "SLH-DSA-SHAKE-192s" };
          case asn1X509PostQuantum.id_slh_dsa_shake_192f:
            return { name: "SLH-DSA-SHAKE-192f" };
          case asn1X509PostQuantum.id_slh_dsa_shake_256s:
            return { name: "SLH-DSA-SHAKE-256s" };
          case asn1X509PostQuantum.id_slh_dsa_shake_256f:
            return { name: "SLH-DSA-SHAKE-256f" };
        }
        return null;
      }
    };
    exports.SlhDsaAlgorithm = tslib.__decorate([
      tsyringe.injectable()
    ], exports.SlhDsaAlgorithm);
    tsyringe.container.registerSingleton(diAlgorithm, exports.SlhDsaAlgorithm);
    var _Pkcs10CertificateRequest_tbs;
    var _Pkcs10CertificateRequest_subjectName;
    var _Pkcs10CertificateRequest_subject;
    var _Pkcs10CertificateRequest_signatureAlgorithm;
    var _Pkcs10CertificateRequest_signature;
    var _Pkcs10CertificateRequest_publicKey;
    var _Pkcs10CertificateRequest_attributes;
    var _Pkcs10CertificateRequest_extensions;
    var Pkcs10CertificateRequest = class extends PemData {
      get subjectName() {
        if (!tslib.__classPrivateFieldGet(this, _Pkcs10CertificateRequest_subjectName, "f")) {
          tslib.__classPrivateFieldSet(this, _Pkcs10CertificateRequest_subjectName, new Name(this.asn.certificationRequestInfo.subject), "f");
        }
        return tslib.__classPrivateFieldGet(this, _Pkcs10CertificateRequest_subjectName, "f");
      }
      get subject() {
        if (!tslib.__classPrivateFieldGet(this, _Pkcs10CertificateRequest_subject, "f")) {
          tslib.__classPrivateFieldSet(this, _Pkcs10CertificateRequest_subject, this.subjectName.toString(), "f");
        }
        return tslib.__classPrivateFieldGet(this, _Pkcs10CertificateRequest_subject, "f");
      }
      get signatureAlgorithm() {
        if (!tslib.__classPrivateFieldGet(this, _Pkcs10CertificateRequest_signatureAlgorithm, "f")) {
          const algProv = tsyringe.container.resolve(diAlgorithmProvider);
          tslib.__classPrivateFieldSet(this, _Pkcs10CertificateRequest_signatureAlgorithm, algProv.toWebAlgorithm(this.asn.signatureAlgorithm), "f");
        }
        return tslib.__classPrivateFieldGet(this, _Pkcs10CertificateRequest_signatureAlgorithm, "f");
      }
      get signature() {
        if (!tslib.__classPrivateFieldGet(this, _Pkcs10CertificateRequest_signature, "f")) {
          tslib.__classPrivateFieldSet(this, _Pkcs10CertificateRequest_signature, this.asn.signature, "f");
        }
        return tslib.__classPrivateFieldGet(this, _Pkcs10CertificateRequest_signature, "f");
      }
      get publicKey() {
        if (!tslib.__classPrivateFieldGet(this, _Pkcs10CertificateRequest_publicKey, "f")) {
          tslib.__classPrivateFieldSet(this, _Pkcs10CertificateRequest_publicKey, new PublicKey(this.asn.certificationRequestInfo.subjectPKInfo, this.parseOptions), "f");
        }
        return tslib.__classPrivateFieldGet(this, _Pkcs10CertificateRequest_publicKey, "f");
      }
      get attributes() {
        if (!tslib.__classPrivateFieldGet(this, _Pkcs10CertificateRequest_attributes, "f")) {
          tslib.__classPrivateFieldSet(this, _Pkcs10CertificateRequest_attributes, this.asn.certificationRequestInfo.attributes.map((o) => AttributeFactory.create(asn1Schema.AsnConvert.serialize(o), this.parseOptions)), "f");
        }
        return tslib.__classPrivateFieldGet(this, _Pkcs10CertificateRequest_attributes, "f");
      }
      get extensions() {
        if (!tslib.__classPrivateFieldGet(this, _Pkcs10CertificateRequest_extensions, "f")) {
          tslib.__classPrivateFieldSet(this, _Pkcs10CertificateRequest_extensions, [], "f");
          const extensions = this.getAttribute(asnPkcs9.id_pkcs9_at_extensionRequest);
          if (extensions instanceof ExtensionsAttribute) {
            tslib.__classPrivateFieldSet(this, _Pkcs10CertificateRequest_extensions, extensions.items, "f");
          }
        }
        return tslib.__classPrivateFieldGet(this, _Pkcs10CertificateRequest_extensions, "f");
      }
      get tbs() {
        if (!tslib.__classPrivateFieldGet(this, _Pkcs10CertificateRequest_tbs, "f")) {
          tslib.__classPrivateFieldSet(this, _Pkcs10CertificateRequest_tbs, this.asn.certificationRequestInfoRaw || asn1Schema.AsnConvert.serialize(this.asn.certificationRequestInfo), "f");
        }
        return tslib.__classPrivateFieldGet(this, _Pkcs10CertificateRequest_tbs, "f");
      }
      constructor(param, options) {
        const args = PemData.isAsnEncoded(param) ? [param, asn1Csr.CertificationRequest, options] : [param, options];
        super(args[0], args[1], args[2]);
        _Pkcs10CertificateRequest_tbs.set(this, void 0);
        _Pkcs10CertificateRequest_subjectName.set(this, void 0);
        _Pkcs10CertificateRequest_subject.set(this, void 0);
        _Pkcs10CertificateRequest_signatureAlgorithm.set(this, void 0);
        _Pkcs10CertificateRequest_signature.set(this, void 0);
        _Pkcs10CertificateRequest_publicKey.set(this, void 0);
        _Pkcs10CertificateRequest_attributes.set(this, void 0);
        _Pkcs10CertificateRequest_extensions.set(this, void 0);
        this.tag = PemConverter.CertificateRequestTag;
      }
      onInit(_asn) {
      }
      getAttribute(type) {
        for (const attr of this.attributes) {
          if (attr.type === type) {
            return attr;
          }
        }
        return null;
      }
      getAttributes(type) {
        return this.attributes.filter((o) => o.type === type);
      }
      getExtension(type) {
        for (const ext of this.extensions) {
          if (ext.type === type) {
            return ext;
          }
        }
        return null;
      }
      getExtensions(type) {
        return this.extensions.filter((o) => o.type === type);
      }
      async verify(crypto2 = cryptoProvider.get()) {
        const algorithm = {
          ...this.publicKey.algorithm,
          ...this.signatureAlgorithm
        };
        const publicKey = await this.publicKey.export(algorithm, ["verify"], crypto2);
        const signatureFormatters = tsyringe.container.resolveAll(diAsnSignatureFormatter).reverse();
        let signature = null;
        for (const signatureFormatter of signatureFormatters) {
          signature = signatureFormatter.toWebSignature(algorithm, this.signature);
          if (signature) {
            break;
          }
        }
        if (!signature) {
          throw Error("Cannot convert WebCrypto signature value to ASN.1 format");
        }
        const ok = await crypto2.subtle.verify(this.signatureAlgorithm, publicKey, signature, this.tbs);
        return ok;
      }
      toTextObject() {
        const obj = this.toTextObjectEmpty();
        const req = asn1Schema.AsnConvert.parse(this.rawData, asn1Csr.CertificationRequest, this.parseOptions);
        const tbs = req.certificationRequestInfo;
        const data = new TextObject("", {
          Version: `${asn1X509.Version[tbs.version]} (${tbs.version})`,
          Subject: this.subject,
          "Subject Public Key Info": this.publicKey
        });
        if (this.attributes.length) {
          const attrs = new TextObject("");
          for (const ext of this.attributes) {
            const attrObj = ext.toTextObject();
            attrs[attrObj[TextObject.NAME]] = attrObj;
          }
          data["Attributes"] = attrs;
        }
        obj["Data"] = data;
        obj["Signature"] = new TextObject("", {
          Algorithm: TextConverter.serializeAlgorithm(req.signatureAlgorithm),
          "": req.signature
        });
        return obj;
      }
    };
    _Pkcs10CertificateRequest_tbs = /* @__PURE__ */ new WeakMap(), _Pkcs10CertificateRequest_subjectName = /* @__PURE__ */ new WeakMap(), _Pkcs10CertificateRequest_subject = /* @__PURE__ */ new WeakMap(), _Pkcs10CertificateRequest_signatureAlgorithm = /* @__PURE__ */ new WeakMap(), _Pkcs10CertificateRequest_signature = /* @__PURE__ */ new WeakMap(), _Pkcs10CertificateRequest_publicKey = /* @__PURE__ */ new WeakMap(), _Pkcs10CertificateRequest_attributes = /* @__PURE__ */ new WeakMap(), _Pkcs10CertificateRequest_extensions = /* @__PURE__ */ new WeakMap();
    Pkcs10CertificateRequest.NAME = "PKCS#10 Certificate Request";
    var Pkcs10CertificateRequestGenerator = class {
      static async create(params, crypto2 = cryptoProvider.get()) {
        if (!params.keys.privateKey) {
          throw new Error("Bad field 'keys' in 'params' argument. 'privateKey' is empty");
        }
        if (!params.keys.publicKey) {
          throw new Error("Bad field 'keys' in 'params' argument. 'publicKey' is empty");
        }
        const spki = await crypto2.subtle.exportKey("spki", params.keys.publicKey);
        const asnReq = new asn1Csr.CertificationRequest({
          certificationRequestInfo: new asn1Csr.CertificationRequestInfo({
            subjectPKInfo: asn1Schema.AsnConvert.parse(spki, asn1X509.SubjectPublicKeyInfo)
          })
        });
        if (params.name) {
          const name = params.name instanceof Name ? params.name : new Name(params.name);
          asnReq.certificationRequestInfo.subject = asn1Schema.AsnConvert.parse(name.toArrayBuffer(), asn1X509.Name);
        }
        if (params.attributes) {
          for (const o of params.attributes) {
            asnReq.certificationRequestInfo.attributes.push(asn1Schema.AsnConvert.parse(o.rawData, asn1X509.Attribute));
          }
        }
        if (params.extensions && params.extensions.length) {
          const attr = new asn1X509.Attribute({ type: asnPkcs9.id_pkcs9_at_extensionRequest });
          const extensions = new asn1X509.Extensions();
          for (const o of params.extensions) {
            extensions.push(asn1Schema.AsnConvert.parse(o.rawData, asn1X509.Extension));
          }
          attr.values.push(asn1Schema.AsnConvert.serialize(extensions));
          asnReq.certificationRequestInfo.attributes.push(attr);
        }
        const signingAlgorithm = {
          ...params.signingAlgorithm,
          ...params.keys.privateKey.algorithm
        };
        const algProv = tsyringe.container.resolve(diAlgorithmProvider);
        asnReq.signatureAlgorithm = algProv.toAsnAlgorithm(signingAlgorithm);
        const tbs = asn1Schema.AsnConvert.serialize(asnReq.certificationRequestInfo);
        const signature = await crypto2.subtle.sign(signingAlgorithm, params.keys.privateKey, tbs);
        const signatureFormatters = tsyringe.container.resolveAll(diAsnSignatureFormatter).reverse();
        let asnSignature = null;
        for (const signatureFormatter of signatureFormatters) {
          asnSignature = signatureFormatter.toAsnSignature(signingAlgorithm, signature);
          if (asnSignature) {
            break;
          }
        }
        if (!asnSignature) {
          throw Error("Cannot convert WebCrypto signature value to ASN.1 format");
        }
        asnReq.signature = asnSignature;
        return new Pkcs10CertificateRequest(asn1Schema.AsnConvert.serialize(asnReq));
      }
    };
    function toPositiveIntegerOctets(input) {
      let firstNonZero = 0;
      while (firstNonZero < input.length - 1 && input[firstNonZero] === 0) {
        firstNonZero++;
      }
      let serialNumber = input.slice(firstNonZero);
      if (!serialNumber.length) {
        serialNumber = new Uint8Array([0]);
      }
      if (serialNumber[0] > 127) {
        const newSerialNumber = new Uint8Array(serialNumber.length + 1);
        newSerialNumber[0] = 0;
        newSerialNumber.set(serialNumber, 1);
        serialNumber = newSerialNumber;
      }
      return serialNumber.buffer;
    }
    function normalizeCertificateSerialNumber(input) {
      return toPositiveIntegerOctets(pvtsutils.BufferSourceConverter.toUint8Array(pvtsutils.Convert.FromHex(input || "")));
    }
    function generateCertificateSerialNumber(input, crypto2 = cryptoProvider.get()) {
      const inputView = pvtsutils.BufferSourceConverter.toUint8Array(pvtsutils.Convert.FromHex(input || ""));
      const serialNumber = inputView.length && inputView.some((o) => o > 0) ? inputView : crypto2.getRandomValues(new Uint8Array(16));
      return toPositiveIntegerOctets(serialNumber);
    }
    function getCertificateSerialNumber(raw) {
      let serialNumber = pvtsutils.BufferSourceConverter.toUint8Array(raw);
      if (serialNumber.length > 1 && serialNumber[0] === 0 && serialNumber[1] > 127) {
        serialNumber = serialNumber.slice(1);
      }
      return pvtsutils.Convert.ToHex(serialNumber);
    }
    var _X509Certificate_tbs;
    var _X509Certificate_serialNumber;
    var _X509Certificate_subjectName;
    var _X509Certificate_subject;
    var _X509Certificate_issuerName;
    var _X509Certificate_issuer;
    var _X509Certificate_notBefore;
    var _X509Certificate_notAfter;
    var _X509Certificate_signatureAlgorithm;
    var _X509Certificate_signature;
    var _X509Certificate_extensions;
    var _X509Certificate_publicKey;
    var X509Certificate2 = class extends PemData {
      get publicKey() {
        if (!tslib.__classPrivateFieldGet(this, _X509Certificate_publicKey, "f")) {
          tslib.__classPrivateFieldSet(this, _X509Certificate_publicKey, new PublicKey(this.asn.tbsCertificate.subjectPublicKeyInfo, this.parseOptions), "f");
        }
        return tslib.__classPrivateFieldGet(this, _X509Certificate_publicKey, "f");
      }
      get serialNumber() {
        if (!tslib.__classPrivateFieldGet(this, _X509Certificate_serialNumber, "f")) {
          tslib.__classPrivateFieldSet(this, _X509Certificate_serialNumber, getCertificateSerialNumber(this.asn.tbsCertificate.serialNumber), "f");
        }
        return tslib.__classPrivateFieldGet(this, _X509Certificate_serialNumber, "f");
      }
      get subjectName() {
        if (!tslib.__classPrivateFieldGet(this, _X509Certificate_subjectName, "f")) {
          tslib.__classPrivateFieldSet(this, _X509Certificate_subjectName, new Name(this.asn.tbsCertificate.subject), "f");
        }
        return tslib.__classPrivateFieldGet(this, _X509Certificate_subjectName, "f");
      }
      get subject() {
        if (!tslib.__classPrivateFieldGet(this, _X509Certificate_subject, "f")) {
          tslib.__classPrivateFieldSet(this, _X509Certificate_subject, this.subjectName.toString(), "f");
        }
        return tslib.__classPrivateFieldGet(this, _X509Certificate_subject, "f");
      }
      get issuerName() {
        if (!tslib.__classPrivateFieldGet(this, _X509Certificate_issuerName, "f")) {
          tslib.__classPrivateFieldSet(this, _X509Certificate_issuerName, new Name(this.asn.tbsCertificate.issuer), "f");
        }
        return tslib.__classPrivateFieldGet(this, _X509Certificate_issuerName, "f");
      }
      get issuer() {
        if (!tslib.__classPrivateFieldGet(this, _X509Certificate_issuer, "f")) {
          tslib.__classPrivateFieldSet(this, _X509Certificate_issuer, this.issuerName.toString(), "f");
        }
        return tslib.__classPrivateFieldGet(this, _X509Certificate_issuer, "f");
      }
      get notBefore() {
        if (!tslib.__classPrivateFieldGet(this, _X509Certificate_notBefore, "f")) {
          const notBefore = this.asn.tbsCertificate.validity.notBefore.utcTime || this.asn.tbsCertificate.validity.notBefore.generalTime;
          if (!notBefore) {
            throw new Error("Cannot get 'notBefore' value");
          }
          tslib.__classPrivateFieldSet(this, _X509Certificate_notBefore, notBefore, "f");
        }
        return tslib.__classPrivateFieldGet(this, _X509Certificate_notBefore, "f");
      }
      get notAfter() {
        if (!tslib.__classPrivateFieldGet(this, _X509Certificate_notAfter, "f")) {
          const notAfter = this.asn.tbsCertificate.validity.notAfter.utcTime || this.asn.tbsCertificate.validity.notAfter.generalTime;
          if (!notAfter) {
            throw new Error("Cannot get 'notAfter' value");
          }
          tslib.__classPrivateFieldSet(this, _X509Certificate_notAfter, notAfter, "f");
        }
        return tslib.__classPrivateFieldGet(this, _X509Certificate_notAfter, "f");
      }
      get signatureAlgorithm() {
        if (!tslib.__classPrivateFieldGet(this, _X509Certificate_signatureAlgorithm, "f")) {
          const algProv = tsyringe.container.resolve(diAlgorithmProvider);
          tslib.__classPrivateFieldSet(this, _X509Certificate_signatureAlgorithm, algProv.toWebAlgorithm(this.asn.signatureAlgorithm), "f");
        }
        return tslib.__classPrivateFieldGet(this, _X509Certificate_signatureAlgorithm, "f");
      }
      get signature() {
        if (!tslib.__classPrivateFieldGet(this, _X509Certificate_signature, "f")) {
          tslib.__classPrivateFieldSet(this, _X509Certificate_signature, this.asn.signatureValue, "f");
        }
        return tslib.__classPrivateFieldGet(this, _X509Certificate_signature, "f");
      }
      get extensions() {
        if (!tslib.__classPrivateFieldGet(this, _X509Certificate_extensions, "f")) {
          tslib.__classPrivateFieldSet(this, _X509Certificate_extensions, [], "f");
          if (this.asn.tbsCertificate.extensions) {
            tslib.__classPrivateFieldSet(this, _X509Certificate_extensions, this.asn.tbsCertificate.extensions.map((o) => ExtensionFactory.create(asn1Schema.AsnConvert.serialize(o), this.parseOptions)), "f");
          }
        }
        return tslib.__classPrivateFieldGet(this, _X509Certificate_extensions, "f");
      }
      get tbs() {
        if (!tslib.__classPrivateFieldGet(this, _X509Certificate_tbs, "f")) {
          tslib.__classPrivateFieldSet(this, _X509Certificate_tbs, this.asn.tbsCertificateRaw || asn1Schema.AsnConvert.serialize(this.asn.tbsCertificate), "f");
        }
        return tslib.__classPrivateFieldGet(this, _X509Certificate_tbs, "f");
      }
      constructor(param, options) {
        const args = PemData.isAsnEncoded(param) ? [param, asn1X509.Certificate, options] : [param, options];
        super(args[0], args[1], args[2]);
        _X509Certificate_tbs.set(this, void 0);
        _X509Certificate_serialNumber.set(this, void 0);
        _X509Certificate_subjectName.set(this, void 0);
        _X509Certificate_subject.set(this, void 0);
        _X509Certificate_issuerName.set(this, void 0);
        _X509Certificate_issuer.set(this, void 0);
        _X509Certificate_notBefore.set(this, void 0);
        _X509Certificate_notAfter.set(this, void 0);
        _X509Certificate_signatureAlgorithm.set(this, void 0);
        _X509Certificate_signature.set(this, void 0);
        _X509Certificate_extensions.set(this, void 0);
        _X509Certificate_publicKey.set(this, void 0);
        this.tag = PemConverter.CertificateTag;
      }
      onInit(_asn) {
      }
      getExtension(type) {
        for (const ext of this.extensions) {
          if (typeof type === "string") {
            if (ext.type === type) {
              return ext;
            }
          } else {
            if (ext instanceof type) {
              return ext;
            }
          }
        }
        return null;
      }
      getExtensions(type) {
        return this.extensions.filter((o) => {
          if (typeof type === "string") {
            return o.type === type;
          } else {
            return o instanceof type;
          }
        });
      }
      async verify(params = {}, crypto2 = cryptoProvider.get()) {
        let keyAlgorithm;
        let publicKey;
        const paramsKey = params.publicKey;
        try {
          if (!paramsKey) {
            keyAlgorithm = {
              ...this.publicKey.algorithm,
              ...this.signatureAlgorithm
            };
            publicKey = await this.publicKey.export(keyAlgorithm, ["verify"], crypto2);
          } else if ("publicKey" in paramsKey) {
            keyAlgorithm = {
              ...paramsKey.publicKey.algorithm,
              ...this.signatureAlgorithm
            };
            publicKey = await paramsKey.publicKey.export(keyAlgorithm, ["verify"], crypto2);
          } else if (paramsKey instanceof PublicKey) {
            keyAlgorithm = {
              ...paramsKey.algorithm,
              ...this.signatureAlgorithm
            };
            publicKey = await paramsKey.export(keyAlgorithm, ["verify"], crypto2);
          } else if (pvtsutils.BufferSourceConverter.isBufferSource(paramsKey)) {
            const key = new PublicKey(paramsKey);
            keyAlgorithm = {
              ...key.algorithm,
              ...this.signatureAlgorithm
            };
            publicKey = await key.export(keyAlgorithm, ["verify"], crypto2);
          } else {
            keyAlgorithm = {
              ...paramsKey.algorithm,
              ...this.signatureAlgorithm
            };
            publicKey = paramsKey;
          }
        } catch {
          return false;
        }
        const signatureFormatters = tsyringe.container.resolveAll(diAsnSignatureFormatter).reverse();
        let signature = null;
        for (const signatureFormatter of signatureFormatters) {
          signature = signatureFormatter.toWebSignature(keyAlgorithm, this.signature);
          if (signature) {
            break;
          }
        }
        if (!signature) {
          throw Error("Cannot convert ASN.1 signature value to WebCrypto format");
        }
        const ok = await crypto2.subtle.verify(this.signatureAlgorithm, publicKey, signature, this.tbs);
        if (params.signatureOnly) {
          return ok;
        } else {
          const date = params.date || /* @__PURE__ */ new Date();
          const time = date.getTime();
          return ok && this.notBefore.getTime() < time && time < this.notAfter.getTime();
        }
      }
      async getThumbprint(arg1, arg2) {
        let crypto2;
        let algorithm = "SHA-1";
        if (arg1) {
          if (typeof arg1 === "object" && "subtle" in arg1) {
            crypto2 = arg1;
          } else {
            algorithm = arg1;
            crypto2 = arg2;
          }
        }
        crypto2 !== null && crypto2 !== void 0 ? crypto2 : crypto2 = cryptoProvider.get();
        return await crypto2.subtle.digest(algorithm, this.rawData);
      }
      async isSelfSigned(crypto2 = cryptoProvider.get()) {
        return this.subject === this.issuer && await this.verify({ signatureOnly: true }, crypto2);
      }
      toTextObject() {
        const obj = this.toTextObjectEmpty();
        const cert = asn1Schema.AsnConvert.parse(this.rawData, asn1X509.Certificate, this.parseOptions);
        const tbs = cert.tbsCertificate;
        const data = new TextObject("", {
          Version: `${asn1X509.Version[tbs.version]} (${tbs.version})`,
          "Serial Number": tbs.serialNumber,
          "Signature Algorithm": TextConverter.serializeAlgorithm(tbs.signature),
          Issuer: this.issuer,
          Validity: new TextObject("", {
            "Not Before": tbs.validity.notBefore.getTime(),
            "Not After": tbs.validity.notAfter.getTime()
          }),
          Subject: this.subject,
          "Subject Public Key Info": this.publicKey
        });
        if (tbs.issuerUniqueID) {
          data["Issuer Unique ID"] = tbs.issuerUniqueID;
        }
        if (tbs.subjectUniqueID) {
          data["Subject Unique ID"] = tbs.subjectUniqueID;
        }
        if (this.extensions.length) {
          const extensions = new TextObject("");
          for (const ext of this.extensions) {
            const extObj = ext.toTextObject();
            extensions[extObj[TextObject.NAME]] = extObj;
          }
          data["Extensions"] = extensions;
        }
        obj["Data"] = data;
        obj["Signature"] = new TextObject("", {
          Algorithm: TextConverter.serializeAlgorithm(cert.signatureAlgorithm),
          "": cert.signatureValue
        });
        return obj;
      }
    };
    _X509Certificate_tbs = /* @__PURE__ */ new WeakMap(), _X509Certificate_serialNumber = /* @__PURE__ */ new WeakMap(), _X509Certificate_subjectName = /* @__PURE__ */ new WeakMap(), _X509Certificate_subject = /* @__PURE__ */ new WeakMap(), _X509Certificate_issuerName = /* @__PURE__ */ new WeakMap(), _X509Certificate_issuer = /* @__PURE__ */ new WeakMap(), _X509Certificate_notBefore = /* @__PURE__ */ new WeakMap(), _X509Certificate_notAfter = /* @__PURE__ */ new WeakMap(), _X509Certificate_signatureAlgorithm = /* @__PURE__ */ new WeakMap(), _X509Certificate_signature = /* @__PURE__ */ new WeakMap(), _X509Certificate_extensions = /* @__PURE__ */ new WeakMap(), _X509Certificate_publicKey = /* @__PURE__ */ new WeakMap();
    X509Certificate2.NAME = "Certificate";
    var _X509Certificates_options;
    var X509Certificates = class extends Array {
      constructor(param, options) {
        super();
        _X509Certificates_options.set(this, void 0);
        if (PemData.isAsnEncoded(param)) {
          this.import(param, options);
        } else if (param instanceof X509Certificate2) {
          this.push(param);
        } else if (Array.isArray(param)) {
          for (const item of param) {
            this.push(item);
          }
        }
      }
      export(format) {
        const signedData = new asn1Cms__namespace.SignedData();
        signedData.version = 1;
        signedData.encapContentInfo.eContentType = asn1Cms__namespace.id_data;
        signedData.encapContentInfo.eContent = new asn1Cms__namespace.EncapsulatedContent({
          single: new asn1Schema.OctetString()
        });
        signedData.certificates = new asn1Cms__namespace.CertificateSet(this.map((o) => new asn1Cms__namespace.CertificateChoices({
          certificate: asn1Schema.AsnConvert.parse(o.rawData, asn1X509.Certificate, tslib.__classPrivateFieldGet(this, _X509Certificates_options, "f"))
        })));
        const cms = new asn1Cms__namespace.ContentInfo({
          contentType: asn1Cms__namespace.id_signedData,
          content: asn1Schema.AsnConvert.serialize(signedData)
        });
        const raw = asn1Schema.AsnConvert.serialize(cms);
        if (format === "raw") {
          return raw;
        }
        return this.toString(format);
      }
      import(data, options) {
        const raw = PemData.toArrayBuffer(data);
        const cms = asn1Schema.AsnConvert.parse(raw, asn1Cms__namespace.ContentInfo, options);
        if (cms.contentType !== asn1Cms__namespace.id_signedData) {
          throw new TypeError("Cannot parse CMS package. Incoming data is not a SignedData object.");
        }
        const signedData = asn1Schema.AsnConvert.parse(cms.content, asn1Cms__namespace.SignedData, options);
        const certificates = [];
        for (const item of signedData.certificates || []) {
          if (item.certificate) {
            certificates.push(new X509Certificate2(item.certificate, options));
          }
        }
        this.clear();
        for (const certificate2 of certificates) {
          this.push(certificate2);
        }
        tslib.__classPrivateFieldSet(this, _X509Certificates_options, options, "f");
      }
      clear() {
        while (this.pop()) {
        }
      }
      toString(format = "pem") {
        const raw = this.export("raw");
        switch (format) {
          case "pem":
            return PemConverter.encode(raw, "CMS");
          case "pem-chain":
            return this.map((o) => o.toString("pem")).join("\n");
          case "asn":
            return asn1Schema.AsnConvert.toString(raw, tslib.__classPrivateFieldGet(this, _X509Certificates_options, "f"));
          case "hex":
            return pvtsutils.Convert.ToHex(raw);
          case "base64":
            return pvtsutils.Convert.ToBase64(raw);
          case "base64url":
            return pvtsutils.Convert.ToBase64Url(raw);
          case "text":
            return TextConverter.serialize(this.toTextObject());
          default:
            throw TypeError("Argument 'format' is unsupported value");
        }
      }
      toTextObject() {
        const contentInfo = asn1Schema.AsnConvert.parse(this.export("raw"), asn1Cms__namespace.ContentInfo, tslib.__classPrivateFieldGet(this, _X509Certificates_options, "f"));
        const signedData = asn1Schema.AsnConvert.parse(contentInfo.content, asn1Cms__namespace.SignedData, tslib.__classPrivateFieldGet(this, _X509Certificates_options, "f"));
        const obj = new TextObject("X509Certificates", {
          "Content Type": OidSerializer.toString(contentInfo.contentType),
          Content: new TextObject("", {
            Version: `${asn1Cms__namespace.CMSVersion[signedData.version]} (${signedData.version})`,
            Certificates: new TextObject("", { Certificate: this.map((o) => o.toTextObject()) })
          })
        });
        return obj;
      }
    };
    _X509Certificates_options = /* @__PURE__ */ new WeakMap();
    var X509ChainBuilder = class {
      constructor(params = {}) {
        this.certificates = [];
        if (params.certificates) {
          this.certificates = params.certificates;
        }
      }
      async build(cert, crypto2 = cryptoProvider.get()) {
        const chain = new X509Certificates(cert);
        let current = cert;
        while (current = await this.findIssuer(current, crypto2)) {
          const thumbprint = await current.getThumbprint(crypto2);
          for (const item of chain) {
            const thumbprint2 = await item.getThumbprint(crypto2);
            if (pvtsutils.isEqual(thumbprint, thumbprint2)) {
              throw new Error("Cannot build a certificate chain. Circular dependency.");
            }
          }
          chain.push(current);
        }
        return chain;
      }
      async findIssuer(cert, crypto2 = cryptoProvider.get()) {
        if (!await cert.isSelfSigned(crypto2)) {
          const akiExt = cert.getExtension(asn1X509__namespace.id_ce_authorityKeyIdentifier);
          for (const item of this.certificates) {
            if (item.subject !== cert.issuer) {
              continue;
            }
            if (akiExt) {
              if (akiExt.keyId) {
                const skiExt = item.getExtension(asn1X509__namespace.id_ce_subjectKeyIdentifier);
                if (skiExt && skiExt.keyId !== akiExt.keyId) {
                  continue;
                }
              } else if (akiExt.certId) {
                const sanExt = item.getExtension(asn1X509__namespace.id_ce_subjectAltName);
                if (sanExt && !(akiExt.certId.serialNumber === item.serialNumber && pvtsutils.isEqual(asn1Schema.AsnConvert.serialize(akiExt.certId.name), asn1Schema.AsnConvert.serialize(sanExt)))) {
                  continue;
                }
              }
            }
            try {
              const algorithm = {
                ...item.publicKey.algorithm,
                ...cert.signatureAlgorithm
              };
              const publicKey = await item.publicKey.export(algorithm, ["verify"], crypto2);
              const ok = await cert.verify({
                publicKey,
                signatureOnly: true
              }, crypto2);
              if (!ok) {
                continue;
              }
            } catch {
              continue;
            }
            return item;
          }
        }
        return null;
      }
    };
    var X509CertificateGenerator2 = class {
      static async createSelfSigned(params, crypto2 = cryptoProvider.get()) {
        if (!params.keys.privateKey) {
          throw new Error("Bad field 'keys' in 'params' argument. 'privateKey' is empty");
        }
        if (!params.keys.publicKey) {
          throw new Error("Bad field 'keys' in 'params' argument. 'publicKey' is empty");
        }
        return this.create({
          serialNumber: params.serialNumber,
          subject: params.name,
          issuer: params.name,
          notBefore: params.notBefore,
          notAfter: params.notAfter,
          publicKey: params.keys.publicKey,
          signingKey: params.keys.privateKey,
          signingAlgorithm: params.signingAlgorithm,
          extensions: params.extensions
        }, crypto2);
      }
      static async create(params, crypto2 = cryptoProvider.get()) {
        var _a2;
        let spki;
        if (params.publicKey instanceof PublicKey) {
          spki = params.publicKey.rawData;
        } else if ("publicKey" in params.publicKey) {
          spki = params.publicKey.publicKey.rawData;
        } else if (pvtsutils.BufferSourceConverter.isBufferSource(params.publicKey)) {
          spki = params.publicKey;
        } else {
          spki = await crypto2.subtle.exportKey("spki", params.publicKey);
        }
        const serialNumber = generateCertificateSerialNumber(params.serialNumber, crypto2);
        const notBefore = params.notBefore || /* @__PURE__ */ new Date();
        const notAfter = params.notAfter || new Date(notBefore.getTime() + 31536e6);
        const asnX509 = new asn1X509__namespace.Certificate({
          tbsCertificate: new asn1X509__namespace.TBSCertificate({
            version: asn1X509__namespace.Version.v3,
            serialNumber,
            validity: new asn1X509__namespace.Validity({
              notBefore,
              notAfter
            }),
            extensions: new asn1X509__namespace.Extensions(((_a2 = params.extensions) === null || _a2 === void 0 ? void 0 : _a2.map((o) => asn1Schema.AsnConvert.parse(o.rawData, asn1X509__namespace.Extension))) || []),
            subjectPublicKeyInfo: asn1Schema.AsnConvert.parse(spki, asn1X509__namespace.SubjectPublicKeyInfo)
          })
        });
        if (params.subject) {
          const name = params.subject instanceof Name ? params.subject : new Name(params.subject);
          asnX509.tbsCertificate.subject = asn1Schema.AsnConvert.parse(name.toArrayBuffer(), asn1X509__namespace.Name);
        }
        if (params.issuer) {
          const name = params.issuer instanceof Name ? params.issuer : new Name(params.issuer);
          asnX509.tbsCertificate.issuer = asn1Schema.AsnConvert.parse(name.toArrayBuffer(), asn1X509__namespace.Name);
        }
        const defaultSigningAlgorithm = { hash: "SHA-256" };
        const signatureAlgorithm = "signingKey" in params ? {
          ...defaultSigningAlgorithm,
          ...params.signingAlgorithm,
          ...params.signingKey.algorithm
        } : {
          ...defaultSigningAlgorithm,
          ...params.signingAlgorithm
        };
        const algProv = tsyringe.container.resolve(diAlgorithmProvider);
        asnX509.tbsCertificate.signature = asnX509.signatureAlgorithm = algProv.toAsnAlgorithm(signatureAlgorithm);
        const tbs = asn1Schema.AsnConvert.serialize(asnX509.tbsCertificate);
        const signatureValue = "signingKey" in params ? await crypto2.subtle.sign(signatureAlgorithm, params.signingKey, tbs) : params.signature;
        const signatureFormatters = tsyringe.container.resolveAll(diAsnSignatureFormatter).reverse();
        let asnSignature = null;
        for (const signatureFormatter of signatureFormatters) {
          asnSignature = signatureFormatter.toAsnSignature(signatureAlgorithm, signatureValue);
          if (asnSignature) {
            break;
          }
        }
        if (!asnSignature) {
          throw Error("Cannot convert ASN.1 signature value to WebCrypto format");
        }
        asnX509.signatureValue = asnSignature;
        return new X509Certificate2(asn1Schema.AsnConvert.serialize(asnX509));
      }
    };
    var _X509CrlEntry_serialNumber;
    var _X509CrlEntry_revocationDate;
    var _X509CrlEntry_reason;
    var _X509CrlEntry_invalidity;
    var _X509CrlEntry_extensions;
    exports.X509CrlReason = void 0;
    (function(X509CrlReason) {
      X509CrlReason[X509CrlReason["unspecified"] = 0] = "unspecified";
      X509CrlReason[X509CrlReason["keyCompromise"] = 1] = "keyCompromise";
      X509CrlReason[X509CrlReason["cACompromise"] = 2] = "cACompromise";
      X509CrlReason[X509CrlReason["affiliationChanged"] = 3] = "affiliationChanged";
      X509CrlReason[X509CrlReason["superseded"] = 4] = "superseded";
      X509CrlReason[X509CrlReason["cessationOfOperation"] = 5] = "cessationOfOperation";
      X509CrlReason[X509CrlReason["certificateHold"] = 6] = "certificateHold";
      X509CrlReason[X509CrlReason["removeFromCRL"] = 8] = "removeFromCRL";
      X509CrlReason[X509CrlReason["privilegeWithdrawn"] = 9] = "privilegeWithdrawn";
      X509CrlReason[X509CrlReason["aACompromise"] = 10] = "aACompromise";
    })(exports.X509CrlReason || (exports.X509CrlReason = {}));
    var X509CrlEntry = class extends AsnData {
      get serialNumber() {
        if (!tslib.__classPrivateFieldGet(this, _X509CrlEntry_serialNumber, "f")) {
          tslib.__classPrivateFieldSet(this, _X509CrlEntry_serialNumber, getCertificateSerialNumber(this.asn.userCertificate), "f");
        }
        return tslib.__classPrivateFieldGet(this, _X509CrlEntry_serialNumber, "f");
      }
      get revocationDate() {
        if (!tslib.__classPrivateFieldGet(this, _X509CrlEntry_revocationDate, "f")) {
          tslib.__classPrivateFieldSet(this, _X509CrlEntry_revocationDate, this.asn.revocationDate.getTime(), "f");
        }
        return tslib.__classPrivateFieldGet(this, _X509CrlEntry_revocationDate, "f");
      }
      get reason() {
        if (tslib.__classPrivateFieldGet(this, _X509CrlEntry_reason, "f") === void 0) {
          void this.extensions;
        }
        return tslib.__classPrivateFieldGet(this, _X509CrlEntry_reason, "f");
      }
      get invalidity() {
        if (tslib.__classPrivateFieldGet(this, _X509CrlEntry_invalidity, "f") === void 0) {
          void this.extensions;
        }
        return tslib.__classPrivateFieldGet(this, _X509CrlEntry_invalidity, "f");
      }
      get extensions() {
        if (!tslib.__classPrivateFieldGet(this, _X509CrlEntry_extensions, "f")) {
          tslib.__classPrivateFieldSet(this, _X509CrlEntry_extensions, [], "f");
          if (this.asn.crlEntryExtensions) {
            tslib.__classPrivateFieldSet(this, _X509CrlEntry_extensions, this.asn.crlEntryExtensions.map((o) => {
              const extension = ExtensionFactory.create(asn1Schema.AsnConvert.serialize(o), this.parseOptions);
              switch (extension.type) {
                case asn1X509.id_ce_cRLReasons:
                  if (tslib.__classPrivateFieldGet(this, _X509CrlEntry_reason, "f") === void 0) {
                    tslib.__classPrivateFieldSet(this, _X509CrlEntry_reason, asn1Schema.AsnConvert.parse(extension.value, asn1X509.CRLReason, this.parseOptions).reason, "f");
                  }
                  break;
                case asn1X509.id_ce_invalidityDate:
                  if (tslib.__classPrivateFieldGet(this, _X509CrlEntry_invalidity, "f") === void 0) {
                    tslib.__classPrivateFieldSet(this, _X509CrlEntry_invalidity, asn1Schema.AsnConvert.parse(extension.value, asn1X509.InvalidityDate, this.parseOptions).value, "f");
                  }
                  break;
              }
              return extension;
            }), "f");
          }
        }
        return tslib.__classPrivateFieldGet(this, _X509CrlEntry_extensions, "f");
      }
      constructor(...args) {
        let raw;
        let options;
        if (pvtsutils.BufferSourceConverter.isBufferSource(args[0])) {
          raw = pvtsutils.BufferSourceConverter.toArrayBuffer(args[0]);
          options = args[1];
        } else if (typeof args[0] === "string") {
          raw = asn1Schema.AsnConvert.serialize(new asn1X509.RevokedCertificate({
            userCertificate: normalizeCertificateSerialNumber(args[0]),
            revocationDate: new asn1X509.Time(args[1]),
            crlEntryExtensions: args[2]
          }));
        } else if (args[0] instanceof asn1X509.RevokedCertificate) {
          raw = args[0];
          options = args[1];
        }
        if (!raw) {
          throw new TypeError("Cannot create X509CrlEntry instance. Wrong constructor arguments.");
        }
        const superArgs = raw instanceof asn1X509.RevokedCertificate ? [raw, options] : [raw, asn1X509.RevokedCertificate, options];
        super(superArgs[0], superArgs[1], superArgs[2]);
        _X509CrlEntry_serialNumber.set(this, void 0);
        _X509CrlEntry_revocationDate.set(this, void 0);
        _X509CrlEntry_reason.set(this, void 0);
        _X509CrlEntry_invalidity.set(this, void 0);
        _X509CrlEntry_extensions.set(this, void 0);
      }
      onInit(_asn) {
      }
    };
    _X509CrlEntry_serialNumber = /* @__PURE__ */ new WeakMap(), _X509CrlEntry_revocationDate = /* @__PURE__ */ new WeakMap(), _X509CrlEntry_reason = /* @__PURE__ */ new WeakMap(), _X509CrlEntry_invalidity = /* @__PURE__ */ new WeakMap(), _X509CrlEntry_extensions = /* @__PURE__ */ new WeakMap();
    var _X509Crl_tbs;
    var _X509Crl_signatureAlgorithm;
    var _X509Crl_issuerName;
    var _X509Crl_thisUpdate;
    var _X509Crl_nextUpdate;
    var _X509Crl_entries;
    var _X509Crl_extensions;
    var X509Crl = class extends PemData {
      get version() {
        return this.asn.tbsCertList.version;
      }
      get signatureAlgorithm() {
        if (!tslib.__classPrivateFieldGet(this, _X509Crl_signatureAlgorithm, "f")) {
          const algProv = tsyringe.container.resolve(diAlgorithmProvider);
          tslib.__classPrivateFieldSet(this, _X509Crl_signatureAlgorithm, algProv.toWebAlgorithm(this.asn.signatureAlgorithm), "f");
        }
        return tslib.__classPrivateFieldGet(this, _X509Crl_signatureAlgorithm, "f");
      }
      get signature() {
        return this.asn.signature;
      }
      get issuer() {
        return this.issuerName.toString();
      }
      get issuerName() {
        if (!tslib.__classPrivateFieldGet(this, _X509Crl_issuerName, "f")) {
          tslib.__classPrivateFieldSet(this, _X509Crl_issuerName, new Name(this.asn.tbsCertList.issuer), "f");
        }
        return tslib.__classPrivateFieldGet(this, _X509Crl_issuerName, "f");
      }
      get thisUpdate() {
        if (!tslib.__classPrivateFieldGet(this, _X509Crl_thisUpdate, "f")) {
          const thisUpdate = this.asn.tbsCertList.thisUpdate.getTime();
          if (!thisUpdate) {
            throw new Error("Cannot get 'thisUpdate' value");
          }
          tslib.__classPrivateFieldSet(this, _X509Crl_thisUpdate, thisUpdate, "f");
        }
        return tslib.__classPrivateFieldGet(this, _X509Crl_thisUpdate, "f");
      }
      get nextUpdate() {
        var _a2;
        if (tslib.__classPrivateFieldGet(this, _X509Crl_nextUpdate, "f") === void 0) {
          tslib.__classPrivateFieldSet(this, _X509Crl_nextUpdate, ((_a2 = this.asn.tbsCertList.nextUpdate) === null || _a2 === void 0 ? void 0 : _a2.getTime()) || void 0, "f");
        }
        return tslib.__classPrivateFieldGet(this, _X509Crl_nextUpdate, "f");
      }
      get entries() {
        var _a2;
        if (!tslib.__classPrivateFieldGet(this, _X509Crl_entries, "f")) {
          tslib.__classPrivateFieldSet(this, _X509Crl_entries, ((_a2 = this.asn.tbsCertList.revokedCertificates) === null || _a2 === void 0 ? void 0 : _a2.map((o) => new X509CrlEntry(o, this.parseOptions))) || [], "f");
        }
        return tslib.__classPrivateFieldGet(this, _X509Crl_entries, "f");
      }
      get extensions() {
        if (!tslib.__classPrivateFieldGet(this, _X509Crl_extensions, "f")) {
          tslib.__classPrivateFieldSet(this, _X509Crl_extensions, [], "f");
          if (this.asn.tbsCertList.crlExtensions) {
            tslib.__classPrivateFieldSet(this, _X509Crl_extensions, this.asn.tbsCertList.crlExtensions.map((o) => ExtensionFactory.create(asn1Schema.AsnConvert.serialize(o), this.parseOptions)), "f");
          }
        }
        return tslib.__classPrivateFieldGet(this, _X509Crl_extensions, "f");
      }
      get tbs() {
        if (!tslib.__classPrivateFieldGet(this, _X509Crl_tbs, "f")) {
          tslib.__classPrivateFieldSet(this, _X509Crl_tbs, this.asn.tbsCertListRaw || asn1Schema.AsnConvert.serialize(this.asn.tbsCertList), "f");
        }
        return tslib.__classPrivateFieldGet(this, _X509Crl_tbs, "f");
      }
      get tbsCertListSignatureAlgorithm() {
        return this.asn.tbsCertList.signature;
      }
      get certListSignatureAlgorithm() {
        return this.asn.signatureAlgorithm;
      }
      constructor(param, options) {
        const args = PemData.isAsnEncoded(param) ? [param, asn1X509.CertificateList, options] : [param, options];
        super(args[0], args[1], args[2]);
        this.tag = PemConverter.CrlTag;
        _X509Crl_tbs.set(this, void 0);
        _X509Crl_signatureAlgorithm.set(this, void 0);
        _X509Crl_issuerName.set(this, void 0);
        _X509Crl_thisUpdate.set(this, void 0);
        _X509Crl_nextUpdate.set(this, void 0);
        _X509Crl_entries.set(this, void 0);
        _X509Crl_extensions.set(this, void 0);
      }
      onInit(_asn) {
      }
      getExtension(type) {
        for (const ext of this.extensions) {
          if (typeof type === "string") {
            if (ext.type === type) {
              return ext;
            }
          } else {
            if (ext instanceof type) {
              return ext;
            }
          }
        }
        return null;
      }
      getExtensions(type) {
        return this.extensions.filter((o) => {
          if (typeof type === "string") {
            return o.type === type;
          } else {
            return o instanceof type;
          }
        });
      }
      async verify(params, crypto2 = cryptoProvider.get()) {
        if (!this.certListSignatureAlgorithm.isEqual(this.tbsCertListSignatureAlgorithm)) {
          throw new Error("algorithm identifier in the sequence tbsCertList and CertificateList mismatch");
        }
        let keyAlgorithm;
        let publicKey;
        const paramsKey = params.publicKey;
        try {
          if (paramsKey instanceof X509Certificate2) {
            keyAlgorithm = {
              ...paramsKey.publicKey.algorithm,
              ...paramsKey.signatureAlgorithm
            };
            publicKey = await paramsKey.publicKey.export(keyAlgorithm, ["verify"]);
          } else if (paramsKey instanceof PublicKey) {
            keyAlgorithm = {
              ...paramsKey.algorithm,
              ...this.signatureAlgorithm
            };
            publicKey = await paramsKey.export(keyAlgorithm, ["verify"]);
          } else {
            keyAlgorithm = {
              ...paramsKey.algorithm,
              ...this.signatureAlgorithm
            };
            publicKey = paramsKey;
          }
        } catch {
          return false;
        }
        const signatureFormatters = tsyringe.container.resolveAll(diAsnSignatureFormatter).reverse();
        let signature = null;
        for (const signatureFormatter of signatureFormatters) {
          signature = signatureFormatter.toWebSignature(keyAlgorithm, this.signature);
          if (signature) {
            break;
          }
        }
        if (!signature) {
          throw Error("Cannot convert ASN.1 signature value to WebCrypto format");
        }
        return await crypto2.subtle.verify(this.signatureAlgorithm, publicKey, signature, this.tbs);
      }
      async getThumbprint(arg1, arg2) {
        let crypto2;
        let algorithm = "SHA-1";
        if (arg1) {
          if (typeof arg1 === "object" && "subtle" in arg1) {
            crypto2 = arg1;
          } else {
            algorithm = arg1;
            crypto2 = arg2;
          }
        }
        crypto2 !== null && crypto2 !== void 0 ? crypto2 : crypto2 = cryptoProvider.get();
        return await crypto2.subtle.digest(algorithm, this.rawData);
      }
      findRevoked(certOrSerialNumber) {
        const serialNumber = typeof certOrSerialNumber === "string" ? certOrSerialNumber : certOrSerialNumber.serialNumber;
        const serialBuffer = normalizeCertificateSerialNumber(serialNumber);
        for (const revoked of this.asn.tbsCertList.revokedCertificates || []) {
          if (pvtsutils.BufferSourceConverter.isEqual(revoked.userCertificate, serialBuffer)) {
            return new X509CrlEntry(asn1Schema.AsnConvert.serialize(revoked), this.parseOptions);
          }
        }
        return null;
      }
    };
    _X509Crl_tbs = /* @__PURE__ */ new WeakMap(), _X509Crl_signatureAlgorithm = /* @__PURE__ */ new WeakMap(), _X509Crl_issuerName = /* @__PURE__ */ new WeakMap(), _X509Crl_thisUpdate = /* @__PURE__ */ new WeakMap(), _X509Crl_nextUpdate = /* @__PURE__ */ new WeakMap(), _X509Crl_entries = /* @__PURE__ */ new WeakMap(), _X509Crl_extensions = /* @__PURE__ */ new WeakMap();
    var X509CrlGenerator = class {
      static async create(params, crypto2 = cryptoProvider.get()) {
        var _a2;
        const name = params.issuer instanceof Name ? params.issuer : new Name(params.issuer);
        const asnX509Crl = new asn1X509__namespace.CertificateList({
          tbsCertList: new asn1X509__namespace.TBSCertList({
            version: asn1X509__namespace.Version.v2,
            issuer: asn1Schema.AsnConvert.parse(name.toArrayBuffer(), asn1X509__namespace.Name),
            thisUpdate: new asn1X509.Time(params.thisUpdate || /* @__PURE__ */ new Date())
          })
        });
        if (params.nextUpdate) {
          asnX509Crl.tbsCertList.nextUpdate = new asn1X509.Time(params.nextUpdate);
        }
        if (params.extensions && params.extensions.length) {
          asnX509Crl.tbsCertList.crlExtensions = new asn1X509__namespace.Extensions(params.extensions.map((o) => asn1Schema.AsnConvert.parse(o.rawData, asn1X509__namespace.Extension)) || []);
        }
        if (params.entries && params.entries.length) {
          asnX509Crl.tbsCertList.revokedCertificates = [];
          for (const entry of params.entries) {
            const userCertificate = normalizeCertificateSerialNumber(entry.serialNumber);
            const index = asnX509Crl.tbsCertList.revokedCertificates.findIndex((cert) => pvtsutils.isEqual(cert.userCertificate, userCertificate));
            if (index > -1) {
              throw new Error(`Certificate serial number ${entry.serialNumber} already exists in tbsCertList`);
            }
            const revokedCert = new asn1X509.RevokedCertificate({
              userCertificate,
              revocationDate: new asn1X509.Time(entry.revocationDate || /* @__PURE__ */ new Date())
            });
            if ("extensions" in entry && ((_a2 = entry.extensions) === null || _a2 === void 0 ? void 0 : _a2.length)) {
              revokedCert.crlEntryExtensions = entry.extensions.map((o) => asn1Schema.AsnConvert.parse(o.rawData, asn1X509__namespace.Extension));
            } else {
              revokedCert.crlEntryExtensions = [];
            }
            if (!(entry instanceof X509CrlEntry)) {
              if (entry.reason) {
                revokedCert.crlEntryExtensions.push(new asn1X509__namespace.Extension({
                  extnID: asn1X509__namespace.id_ce_cRLReasons,
                  critical: false,
                  extnValue: new asn1Schema.OctetString(asn1Schema.AsnConvert.serialize(new asn1X509__namespace.CRLReason(entry.reason)))
                }));
              }
              if (entry.invalidity) {
                revokedCert.crlEntryExtensions.push(new asn1X509__namespace.Extension({
                  extnID: asn1X509__namespace.id_ce_invalidityDate,
                  critical: false,
                  extnValue: new asn1Schema.OctetString(asn1Schema.AsnConvert.serialize(new asn1X509__namespace.InvalidityDate(entry.invalidity)))
                }));
              }
              if (entry.issuer) {
                const name2 = params.issuer instanceof Name ? params.issuer : new Name(params.issuer);
                revokedCert.crlEntryExtensions.push(new asn1X509__namespace.Extension({
                  extnID: asn1X509__namespace.id_ce_certificateIssuer,
                  critical: false,
                  extnValue: new asn1Schema.OctetString(asn1Schema.AsnConvert.serialize(asn1Schema.AsnConvert.parse(name2.toArrayBuffer(), asn1X509__namespace.Name)))
                }));
              }
            }
            asnX509Crl.tbsCertList.revokedCertificates.push(revokedCert);
          }
        }
        const signingAlgorithm = {
          ...params.signingAlgorithm,
          ...params.signingKey.algorithm
        };
        const algProv = tsyringe.container.resolve(diAlgorithmProvider);
        asnX509Crl.tbsCertList.signature = asnX509Crl.signatureAlgorithm = algProv.toAsnAlgorithm(signingAlgorithm);
        const tbs = asn1Schema.AsnConvert.serialize(asnX509Crl.tbsCertList);
        const signature = await crypto2.subtle.sign(signingAlgorithm, params.signingKey, tbs);
        const signatureFormatters = tsyringe.container.resolveAll(diAsnSignatureFormatter).reverse();
        let asnSignature = null;
        for (const signatureFormatter of signatureFormatters) {
          asnSignature = signatureFormatter.toAsnSignature(signingAlgorithm, signature);
          if (asnSignature) {
            break;
          }
        }
        if (!asnSignature) {
          throw Error("Cannot convert ASN.1 signature value to WebCrypto format");
        }
        asnX509Crl.signature = asnSignature;
        return new X509Crl(asn1Schema.AsnConvert.serialize(asnX509Crl));
      }
    };
    ExtensionFactory.register(asn1X509__namespace.id_ce_basicConstraints, BasicConstraintsExtension2);
    ExtensionFactory.register(asn1X509__namespace.id_ce_extKeyUsage, ExtendedKeyUsageExtension2);
    ExtensionFactory.register(asn1X509__namespace.id_ce_keyUsage, KeyUsagesExtension2);
    ExtensionFactory.register(asn1X509__namespace.id_ce_subjectKeyIdentifier, SubjectKeyIdentifierExtension);
    ExtensionFactory.register(asn1X509__namespace.id_ce_authorityKeyIdentifier, AuthorityKeyIdentifierExtension);
    ExtensionFactory.register(asn1X509__namespace.id_ce_subjectAltName, SubjectAlternativeNameExtension2);
    ExtensionFactory.register(asn1X509__namespace.id_ce_cRLDistributionPoints, CRLDistributionPointsExtension);
    ExtensionFactory.register(asn1X509__namespace.id_pe_authorityInfoAccess, AuthorityInfoAccessExtension);
    ExtensionFactory.register(asn1X509__namespace.id_ce_issuerAltName, IssuerAlternativeNameExtension);
    AttributeFactory.register(asnPkcs9__namespace.id_pkcs9_at_challengePassword, ChallengePasswordAttribute);
    AttributeFactory.register(asnPkcs9__namespace.id_pkcs9_at_extensionRequest, ExtensionsAttribute);
    tsyringe.container.registerSingleton(diAsnSignatureFormatter, AsnDefaultSignatureFormatter);
    tsyringe.container.registerSingleton(diAsnSignatureFormatter, AsnEcSignatureFormatter);
    AsnEcSignatureFormatter.namedCurveSize.set("P-256", 32);
    AsnEcSignatureFormatter.namedCurveSize.set("K-256", 32);
    AsnEcSignatureFormatter.namedCurveSize.set("P-384", 48);
    AsnEcSignatureFormatter.namedCurveSize.set("P-521", 66);
    exports.AlgorithmProvider = AlgorithmProvider;
    exports.AsnData = AsnData;
    exports.AsnDefaultSignatureFormatter = AsnDefaultSignatureFormatter;
    exports.AsnEcSignatureFormatter = AsnEcSignatureFormatter;
    exports.Attribute = Attribute;
    exports.AttributeFactory = AttributeFactory;
    exports.AuthorityInfoAccessExtension = AuthorityInfoAccessExtension;
    exports.AuthorityKeyIdentifierExtension = AuthorityKeyIdentifierExtension;
    exports.BasicConstraintsExtension = BasicConstraintsExtension2;
    exports.CRLDistributionPointsExtension = CRLDistributionPointsExtension;
    exports.CertificatePolicyExtension = CertificatePolicyExtension;
    exports.ChallengePasswordAttribute = ChallengePasswordAttribute;
    exports.CryptoProvider = CryptoProvider;
    exports.DN = DN;
    exports.DNS = DNS;
    exports.DefaultAlgorithmSerializer = DefaultAlgorithmSerializer;
    exports.EMAIL = EMAIL;
    exports.ExtendedKeyUsageExtension = ExtendedKeyUsageExtension2;
    exports.Extension = Extension;
    exports.ExtensionFactory = ExtensionFactory;
    exports.ExtensionsAttribute = ExtensionsAttribute;
    exports.GUID = GUID;
    exports.GeneralName = GeneralName;
    exports.GeneralNames = GeneralNames;
    exports.IP = IP;
    exports.IssuerAlternativeNameExtension = IssuerAlternativeNameExtension;
    exports.KeyUsagesExtension = KeyUsagesExtension2;
    exports.Name = Name;
    exports.NameIdentifier = NameIdentifier;
    exports.OidSerializer = OidSerializer;
    exports.PemConverter = PemConverter;
    exports.PemData = PemData;
    exports.Pkcs10CertificateRequest = Pkcs10CertificateRequest;
    exports.Pkcs10CertificateRequestGenerator = Pkcs10CertificateRequestGenerator;
    exports.PublicKey = PublicKey;
    exports.REGISTERED_ID = REGISTERED_ID;
    exports.SubjectAlternativeNameExtension = SubjectAlternativeNameExtension2;
    exports.SubjectKeyIdentifierExtension = SubjectKeyIdentifierExtension;
    exports.TextConverter = TextConverter;
    exports.TextObject = TextObject;
    exports.UPN = UPN;
    exports.URL = URL2;
    exports.X509Certificate = X509Certificate2;
    exports.X509CertificateGenerator = X509CertificateGenerator2;
    exports.X509Certificates = X509Certificates;
    exports.X509ChainBuilder = X509ChainBuilder;
    exports.X509Crl = X509Crl;
    exports.X509CrlEntry = X509CrlEntry;
    exports.X509CrlGenerator = X509CrlGenerator;
    exports.cryptoProvider = cryptoProvider;
    exports.diAlgorithm = diAlgorithm;
    exports.diAlgorithmProvider = diAlgorithmProvider;
    exports.diAsnSignatureFormatter = diAsnSignatureFormatter;
    exports.idEd25519 = idEd25519;
    exports.idEd448 = idEd448;
    exports.idX25519 = idX25519;
    exports.idX448 = idX448;
  }
});

// src/mobile/activation.ts
import { createPrivateKey as createPrivateKey2, randomUUID as randomUUID4, X509Certificate } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP as isIP2 } from "node:net";
import { join as join2 } from "node:path";

// src/mobile/expo-push.ts
var ExpoPushProvider = class {
  constructor(accessToken, transport = fetch, now = Date.now) {
    this.accessToken = accessToken;
    this.transport = transport;
    this.now = now;
    if (!accessToken || /[\r\n]/.test(accessToken)) throw new Error("Owner-provisioned Expo enhanced push security token required");
  }
  accessToken;
  transport;
  now;
  windowAt = 0;
  submitted = 0;
  async post(path, body) {
    const result = await this.transport(`https://exp.host/--/api/v2/push/${path}`, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(1e4),
      headers: { authorization: `Bearer ${this.accessToken}`, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(body)
    });
    if (result.status !== 200) return void 0;
    const text = await result.text();
    if (text.length > 32 * 1024) return void 0;
    try {
      return JSON.parse(text);
    } catch {
      return void 0;
    }
  }
  async submit(registration, hint) {
    if (this.now() - this.windowAt >= 1e3) {
      this.windowAt = this.now();
      this.submitted = 0;
    }
    if (++this.submitted > 100) return { state: "retry-later" };
    const payload = { to: registration.expoPushToken, title: "agent-bridge", body: "Open the app to review an update", data: { v: 1, notificationId: hint.data.notificationId }, ttl: 300, channelId: "owner-updates" };
    if (Buffer.byteLength(JSON.stringify(payload)) > 4096) return { state: "retry-later" };
    const result = await this.post("send", payload);
    if (result?.data?.details?.error === "DeviceNotRegistered") return { state: "device-not-registered" };
    if (result?.data?.status === "ok" && typeof result.data.id === "string" && /^[\w-]{1,128}$/.test(result.data.id)) return { state: "submitted", ticketId: result.data.id };
    return { state: "retry-later" };
  }
  async receipt(ticketId) {
    if (!/^[\w-]{1,128}$/.test(ticketId)) return { state: "failed" };
    const result = await this.post("getReceipts", { ids: [ticketId] });
    const receipt = result?.data?.[ticketId];
    if (!receipt) return { state: "pending" };
    if (receipt.details?.error === "DeviceNotRegistered") return { state: "device-not-registered" };
    return { state: receipt.status === "ok" ? "provider-accepted" : "failed" };
  }
};

// src/mobile/adapter.ts
import { createHash } from "node:crypto";
var opaqueId = (kind, parts) => createHash("sha256").update(JSON.stringify([kind, ...parts])).digest("base64url");
var version = (value) => opaqueId("version", [value]);
function projectQuestion(q, pcId) {
  return {
    id: q.id,
    kind: "question",
    pcId,
    projectId: opaqueId("project", [pcId, normalizeProject(q.project)]),
    title: q.title,
    context: q.context,
    topic: q.topic,
    options: q.options.map((o) => ({ id: o.id, label: o.label, consequence: o.consequence, recommended: o.recommended })),
    links: q.links.map((l) => ({ kind: l.kind, display: l.kind === "issue" && /^[\w-]{1,100}$/.test(l.value) ? l.value : `${l.kind} reference` })),
    blocking: q.blocking,
    blocks: q.blocks,
    meanwhile: q.meanwhile,
    destructive: q.destructive,
    authorization: q.authorization,
    urgency: q.urgency,
    declaredDefault: q.default ? { option: q.default.option, deadline: q.default.deadline } : null,
    status: q.status,
    askedAt: q.askedAt,
    version: ownerQuestionVersion(q),
    answer: q.answer ? { text: q.answer.text, ...q.answer.option ? { option: q.answer.option } : {}, at: q.answer.at, source: q.answer.source, authorLabel: q.answer.source === "owner" ? "Owner" : "Declared default" } : null,
    deliveries: q.deliveries.map((d) => ({ recipientLabel: d.recipient, state: d.state, consumedAt: d.readAt })),
    dismissal: q.dismissal ? { reason: q.dismissal.reason, at: q.dismissal.at, ...q.dismissal.supersededBy ? { replacementId: q.dismissal.supersededBy } : {} } : null
  };
}
var LocalMobileSource = class {
  constructor(ctx, questions, pcId, ready, completeAnswer, listQuestions = () => questions.list()) {
    this.ctx = ctx;
    this.questions = questions;
    this.pcId = pcId;
    this.ready = ready;
    this.completeAnswer = completeAnswer;
    this.listQuestions = listQuestions;
  }
  ctx;
  questions;
  pcId;
  ready;
  completeAnswer;
  listQuestions;
  bindings = /* @__PURE__ */ new Map();
  async snapshot() {
    if (!this.ready()) throw new MobileFault(503, "source_unavailable");
    const sampledAt = Date.now();
    const peers = (await this.ctx.peers()).filter((p) => !p.name.includes("/"));
    const runs = await listRunsResponsive(this.ctx.home);
    if (!this.ready()) throw new MobileFault(503, "source_unavailable");
    const bindings = /* @__PURE__ */ new Map();
    const sessions = peers.slice(0, 1e4).map((p) => {
      const generation = opaqueId("generation", [p.id, p.sessionId ?? null]), id2 = opaqueId("session", [this.pcId, p.id, generation]), chatId = opaqueId("chat", [id2]);
      if (p.sessionId) bindings.set(chatId, { kind: "session", nativeName: p.name, generation });
      const state = {
        id: id2,
        pcId: this.pcId,
        generation,
        name: p.name.slice(0, 160),
        agent: p.agent,
        projectId: opaqueId("project", [this.pcId, normalizeProject(p.projectRoot ?? p.cwd)]),
        activity: p.activity === "busy" || p.activity === "idle" ? p.activity : "unknown",
        connection: p.unavailable ? "unavailable" : "connected",
        parentId: null,
        chatId: p.sessionId ? chatId : null,
        sendSupported: false
      };
      return { ...state, sampledAt, version: version(state) };
    });
    const jobs = runs.slice(0, 1e4).map((r) => {
      const id2 = opaqueId("job", [this.pcId, r.name, r.startedAt]), generation = opaqueId("run", [r.name, r.startedAt]), chatId = opaqueId("chat", [id2]);
      bindings.set(id2, { kind: "job", nativeName: r.name, generation });
      bindings.set(chatId, { kind: "job", nativeName: r.name, generation });
      const state = {
        id: id2,
        pcId: this.pcId,
        projectId: r.workdir ? opaqueId("project", [this.pcId, normalizeProject(r.workdir)]) : null,
        parentId: null,
        title: (r.title ?? r.job ?? r.name).slice(0, 160),
        status: r.status,
        progress: { percent: typeof r.percent === "number" ? r.percent : null, note: r.progressNote?.slice(0, 500) ?? null, at: r.updatedAt ?? null, etaAt: r.etaAt ?? null, etaReportedAt: r.etaReportedAt ?? null },
        chatId,
        hasSteps: r.hasLog !== false,
        archived: r.archived ?? false,
        recovered: r.recovered ?? false
      };
      return { ...state, sampledAt, version: version(state) };
    });
    this.bindings = bindings;
    return { sessions, jobs, questions: this.listQuestions().slice(0, 1e4).map((q) => projectQuestion(q, this.pcId)), sampledAt, sourceState: "ready" };
  }
  async read(binding, suffix, cursor) {
    if (!this.ready()) throw new MobileFault(503, "source_unavailable");
    let context = this.ctx;
    const validateRun = async () => {
      const run = (await listRunsResponsive(this.ctx.home)).find((r) => r.name === binding.nativeName);
      if (!run || opaqueId("run", [run.name, run.startedAt]) !== binding.generation) throw new MobileFault(410, "snapshot_required");
    };
    if (binding.kind === "session") {
      const peers = await this.ctx.peers(), peer = peers.find((p) => p.name === binding.nativeName && !p.name.includes("/"));
      if (!peer || opaqueId("generation", [peer.id, peer.sessionId ?? null]) !== binding.generation) throw new MobileFault(410, "snapshot_required");
      context = { ...this.ctx, peers: () => [peer] };
    } else await validateRun();
    const path = binding.kind === "session" ? `/api/sessions/${encodeURIComponent(binding.nativeName)}/chat` : `/api/runs/${encodeURIComponent(binding.nativeName)}${suffix}`;
    const result = await readDashboard(context, { path, ...cursor ? { query: { from: cursor } } : {} });
    if (!this.ready()) throw new MobileFault(503, "source_unavailable");
    if (binding.kind === "job") await validateRun();
    if (result.status !== 200) throw new MobileFault(result.status === 409 ? 409 : result.status === 404 ? 404 : 503, "source_unavailable");
    return result.body;
  }
  async chat(id2, cursor, limit) {
    const binding = this.bindings.get(id2);
    if (!binding) throw new MobileFault(404, "unsupported");
    const result = await this.read(binding, "/chat", cursor ?? "tail");
    const items = result.items.map((item, index) => ({
      id: item.id ?? opaqueId("item", [id2, binding.generation, cursor ?? "tail", index, item.at]),
      kind: item.kind,
      at: item.at,
      ...item.text !== void 0 ? { text: item.text.slice(0, 16e3) } : {},
      ...item.tool !== void 0 ? { tool: item.tool.slice(0, 160) } : {},
      ...item.summary !== void 0 ? { summary: item.summary.slice(0, 1200) } : {},
      version: version(item),
      truncated: (item.text?.length ?? 0) > 16e3 || (item.summary?.length ?? 0) > 1200
    }));
    return { items, next: result.next && result.next !== cursor ? result.next : null, generation: binding.generation, reset: false };
  }
  async steps(id2, cursor, limit) {
    const binding = this.bindings.get(id2);
    if (!binding || binding.kind !== "job") throw new MobileFault(404, "unsupported");
    const result = await this.read(binding, "", cursor ?? "0");
    if (result.recovered || typeof result.text !== "string") throw new MobileFault(404, "unsupported");
    return {
      items: [{ id: opaqueId("step", [id2, cursor ?? "0"]), text: result.text.slice(0, 128 * 1024), at: null }],
      next: result.next !== void 0 && result.next < (result.size ?? 0) ? String(result.next) : null,
      generation: binding.generation,
      reset: false
    };
  }
  async answer(id2, body, deviceId, key) {
    if (!this.ready()) throw new MobileFault(503, "source_unavailable");
    const q = this.questions.answerMobile(id2, body, deviceId, key, { id: `owner:mobile:${deviceId}`, name: "Owner (mobile)", agent: "other" });
    const latest = this.questions.get(q.id) ?? q;
    try {
      if (!latest.deliveryComplete) this.completeAnswer?.(latest);
    } catch {
    }
    return projectQuestion(this.listQuestions().find((latest2) => latest2.id === q.id) ?? q, this.pcId);
  }
};

// src/mobile/gateway.ts
import { randomUUID as randomUUID2 } from "node:crypto";

// src/mobile/push.ts
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
var MobilePush = class {
  constructor(store, provider, encryptionKey, projectId, environment) {
    this.store = store;
    this.provider = provider;
    this.encryptionKey = encryptionKey;
    this.projectId = projectId;
    this.environment = environment;
    if (encryptionKey && encryptionKey.byteLength !== 32) throw new Error("Push encryption key must be 256 bits");
  }
  store;
  provider;
  encryptionKey;
  projectId;
  environment;
  get configured() {
    return !!(this.provider && this.encryptionKey && this.projectId && this.environment);
  }
  register(device, registration) {
    if (!this.configured) throw new MobileFault(409, "push_unsupported");
    if (this.store.get("device", device.id)?.revoked !== false) throw new MobileFault(401, "device_revoked");
    if (registration.projectId !== this.projectId || registration.environment !== this.environment || registration.platform !== device.platform) throw new MobileFault(403, "push_project_mismatch");
    const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", this.encryptionKey, iv);
    cipher.setAAD(Buffer.from(device.id));
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(registration)), cipher.final()]);
    this.store.put("push", device.id, { iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), ciphertext: ciphertext.toString("base64") });
    return { state: "registered" };
  }
  remove(deviceId, reason = "unsubscribe") {
    this.store.archivePush(deviceId, reason);
  }
  async notify(question, current) {
    if (!this.configured || question.pcId !== this.store.pcId) return [];
    const results = [];
    for (const device of this.store.list("device")) {
      const q = await current();
      const active = this.store.get("device", device.id);
      if (!q || q.status !== "open" || !active || active.revoked || !this.store.can(active, "questions.read", q.pcId, { kind: "question", id: q.id, projectId: q.projectId })) continue;
      const subscription = this.store.get("push", active.id);
      if (!subscription) continue;
      const dedupe = `${active.id}:${q.id}:${q.askedAt}`;
      if (this.store.get("push-dedupe", dedupe)) continue;
      const id2 = randomUUID();
      this.store.put("hint", id2, { id: id2, deviceId: active.id, questionId: q.id, expiresAt: this.store.now() + 3e5 });
      const decipher = createDecipheriv("aes-256-gcm", this.encryptionKey, Buffer.from(subscription.iv, "base64"));
      decipher.setAAD(Buffer.from(active.id));
      decipher.setAuthTag(Buffer.from(subscription.tag, "base64"));
      const registration = JSON.parse(Buffer.concat([decipher.update(Buffer.from(subscription.ciphertext, "base64")), decipher.final()]).toString());
      this.store.put("push-dedupe", dedupe, { state: "unconfirmed" });
      try {
        const result = await this.provider.submit(registration, { title: "agent-bridge", body: "Open the app to review an update", data: { v: 1, notificationId: id2 }, ttl: 300 });
        if (result.state === "device-not-registered") this.store.archivePush(active.id, "provider-invalid", subscription.ciphertext);
        this.store.put("push-dedupe", dedupe, { state: result.state });
        results.push({ state: result.state });
      } catch {
        results.push({ state: "unconfirmed" });
      }
    }
    return results;
  }
  resolve(device, id2, questions) {
    const hint = this.store.get("hint", id2), q = hint && questions.find((q2) => q2.id === hint.questionId);
    if (!hint || hint.deviceId !== device.id || hint.expiresAt <= this.store.now() || !q || !this.store.can(device, "questions.read", q.pcId, { kind: "question", id: q.id, projectId: q.projectId })) throw new MobileFault(410, "notification_gone");
    return { questionId: q.id };
  }
};

// src/mobile/gateway.ts
var uuid = external_exports.string().uuid();
var id = external_exports.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
var token = external_exports.string().min(40).max(256);
var answerSchema = external_exports.object({ expectedVersion: token, option: external_exports.string().min(1).max(40).optional(), text: external_exports.string().min(1).max(8e3).optional() }).strict().refine((a) => !!a.option !== !!a.text);
var pushSchema = external_exports.object({ expoPushToken: external_exports.string().regex(/^(Expo|Exponent)PushToken\[[\w-]+\]$/).max(256), platform: external_exports.enum(["android", "ios"]), projectId: uuid, environment: external_exports.enum(["development", "production"]) }).strict();
var CAPS = ["overview.read", "chat.read", "questions.read", "questions.answer"];
var MobileGateway = class {
  constructor(store, source, push = new MobilePush(store), diagnostics = (diagnostic) => console.error(diagnostic), ready = () => true) {
    this.store = store;
    this.source = source;
    this.push = push;
    this.diagnostics = diagnostics;
    this.ready = ready;
  }
  store;
  source;
  push;
  diagnostics;
  ready;
  epoch = randomUUID2();
  views = /* @__PURE__ */ new Map();
  cursors = /* @__PURE__ */ new Map();
  rates = /* @__PURE__ */ new Map();
  sampling;
  available = true;
  inFlight = /* @__PURE__ */ new Set();
  closing;
  hello(pinning = false) {
    return { apiVersion: 1, capabilities: CAPS, transport: "private-https", pinning, send: "unsupported", pairedPcWrites: "unsupported", push: this.push.configured ? "configured" : "unsupported" };
  }
  /** Owned host retirement; no registry reads or writes after it is closed. */
  deactivate() {
    this.available = false;
    this.views.clear();
    this.cursors.clear();
  }
  /** Stop admission immediately; settle owned handlers before the host retires its stores. */
  close() {
    if (this.closing) return this.closing;
    this.deactivate();
    this.closing = (async () => {
      let timer;
      try {
        const drained = await Promise.race([
          Promise.allSettled([...this.inFlight]).then(() => true),
          new Promise((resolve) => {
            timer = setTimeout(() => resolve(false), 5e3);
          })
        ]);
        if (!drained) {
          try {
            this.diagnostics({ requestId: randomUUID2(), errorCategory: "gateway_shutdown_timeout" });
          } catch {
          }
          throw new MobileFault(503, "gateway_shutdown_timeout");
        }
      } finally {
        if (timer) clearTimeout(timer);
      }
    })();
    return this.closing;
  }
  rate(principal, max) {
    const now = this.store.now(), prior = this.rates.get(principal);
    if (!prior || now - prior.at >= 6e4) {
      if (this.rates.size >= 1e4) this.rates.clear();
      this.rates.set(principal, { at: now, count: 1 });
      return;
    }
    if (++prior.count > max) throw new MobileFault(429, "rate_limited");
  }
  cursor(device, kind, viewCursor, payload) {
    const key = secret();
    if (this.cursors.size >= 1e4) this.cursors.delete(this.cursors.keys().next().value);
    this.cursors.set(key, { deviceId: device.id, revision: device.revision, kind, expiresAt: this.store.now() + 24 * 60 * 6e4, viewCursor, payload });
    return key;
  }
  fromCursor(device, key, kind) {
    const c = this.cursors.get(key);
    if (!c || c.deviceId !== device.id || c.revision !== device.revision || c.kind !== kind || c.expiresAt <= this.store.now()) throw new MobileFault(410, "snapshot_required");
    return c;
  }
  recordWriteProof(principal, snapshot) {
    if (snapshot.stale) return;
    const record = this.fromCursor(principal.device, snapshot.cursor, "events");
    record.writeProof = {
      epoch: this.epoch,
      sessionId: principal.session.id,
      accessHash: principal.session.accessHash,
      grantHash: digest("grants", JSON.stringify(principal.device.grants)),
      sampledAt: snapshot.sampledAt
    };
  }
  requireWriteProof(principal, cursor, snapshot) {
    const proof = cursor ? this.fromCursor(principal.device, cursor, "events").writeProof : void 0;
    const age = proof ? this.store.now() - proof.sampledAt : Infinity;
    if (!proof || snapshot.stale || proof.epoch !== this.epoch || proof.sessionId !== principal.session.id || proof.accessHash !== principal.session.accessHash || proof.grantHash !== digest("grants", JSON.stringify(principal.device.grants)) || !Number.isFinite(age) || age < 0 || age >= 15e3)
      throw new MobileFault(409, "fresh_snapshot_required");
  }
  async sample() {
    if (!this.sampling) this.sampling = this.source.snapshot().finally(() => {
      this.sampling = void 0;
    });
    return this.deadline(this.sampling);
  }
  async deadline(work) {
    let timer;
    try {
      return await Promise.race([work, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new MobileFault(503, "source_unavailable")), 5e3);
      })]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  authorized(device, kind, capability, entities) {
    return entities.filter((e) => (kind !== "question" || e.pcId === this.store.pcId) && this.store.can(device, capability, e.pcId, { kind, id: e.id, projectId: e.projectId }));
  }
  collection(device, kind, items, count, viewCursor, offset = 0, generation = this.epoch) {
    const page = items.slice(offset, offset + count);
    while (page.length > 1 && Buffer.byteLength(JSON.stringify(page)) > 480 * 1024) page.pop();
    const nextOffset = offset + page.length;
    return { items: page, next: nextOffset < items.length ? this.cursor(device, kind, viewCursor, { items, offset: nextOffset, generation }) : null, generation, reset: false, sampledAt: this.store.now(), viewCursor };
  }
  async view(principal) {
    const raw = await this.sample();
    if (!this.available) throw new MobileFault(503, "source_unavailable");
    const device = this.store.get("device", principal.device.id);
    if (!device || device.revoked) throw new MobileFault(401, "device_revoked");
    if (device.revision !== principal.device.revision) throw new MobileFault(410, "authorization_changed");
    const all = {
      sessions: this.authorized(device, "session", "overview.read", raw.sessions),
      jobs: this.authorized(device, "job", "overview.read", raw.jobs),
      questions: this.authorized(device, "question", "questions.read", raw.questions),
      sampledAt: raw.sampledAt,
      sourceState: raw.sourceState
    };
    const stale = raw.sourceState !== "ready" || this.store.now() - raw.sampledAt > 15e3;
    if (stale) {
      for (const cursor2 of this.cursors.values()) if (cursor2.deviceId === device.id) cursor2.writeProof = void 0;
    }
    const signature = digest("view", JSON.stringify([all.sessions.map((s) => [s.id, s.version]), all.jobs.map((j) => [j.id, j.version]), all.questions.map((q) => [q.id, q.version, q.deliveries]), stale, all.sourceState, device.revision]));
    const old = this.views.get(device.id);
    const oldCursor = old && this.cursors.get(old.snapshot.cursor);
    const cursor = old?.signature === signature && oldCursor && oldCursor.expiresAt > this.store.now() ? old.snapshot.cursor : this.cursor(device, "events", "");
    const capabilities = [...new Set(device.grants.flatMap((g) => g.capabilities))];
    const sessions = this.collection(device, "sessions", all.sessions, 20, cursor), jobs = this.collection(device, "jobs", all.jobs, 20, cursor), questions = this.collection(device, "questions", all.questions, 20, cursor);
    const snapshot = {
      apiVersion: 1,
      pcId: this.store.pcId,
      epoch: this.epoch,
      cursor,
      sampledAt: raw.sampledAt,
      stale,
      capabilities,
      sessions: sessions.items,
      jobs: jobs.items,
      questions: questions.items,
      pages: { sessions: sessions.next, jobs: jobs.next, questions: questions.next },
      sourceState: raw.sourceState
    };
    const result = { snapshot, all, signature, deviceRevision: device.revision };
    this.views.set(device.id, result);
    return result;
  }
  require(device, capability) {
    if (!device.grants.some((g) => g.capabilities.includes(capability))) throw new MobileFault(403, "capability_required");
  }
  async content(principal, view, entityId, kind, cursor, limit) {
    const device = principal.device;
    const parent = kind === "steps" ? view.all.jobs.find((j) => j.id === entityId) : view.all.sessions.find((s) => s.chatId === entityId) ?? view.all.jobs.find((j) => j.chatId === entityId);
    if (!parent) throw new MobileFault(404, "not_found");
    const parentKind = "generation" in parent ? "session" : "job";
    if (!this.store.can(device, kind === "chat" ? "chat.read" : "overview.read", parent.pcId, { kind: parentKind, id: parent.id, projectId: parent.projectId })) throw new MobileFault(404, "not_found");
    let remaining = [], nativeNext = null, generation = "", existing = false;
    if (cursor) {
      const c = this.fromCursor(device, cursor, `${kind}:${entityId}`);
      if (c.viewCursor !== view.snapshot.cursor) throw new MobileFault(410, "snapshot_required");
      const payload = c.payload;
      remaining = payload.remaining;
      nativeNext = payload.nativeNext;
      generation = payload.generation;
      existing = true;
    }
    if (!existing || remaining.length === 0 && nativeNext) {
      const page = kind === "chat" ? await this.deadline(this.source.chat(entityId, nativeNext ?? void 0, limit)) : await this.deadline(this.source.steps(entityId, nativeNext ?? void 0, limit));
      if (existing && generation !== page.generation || page.reset) throw new MobileFault(410, "snapshot_required");
      remaining = page.items;
      generation = page.generation;
      nativeNext = page.next;
    }
    if (!this.available) throw new MobileFault(503, "source_unavailable");
    const active = this.store.get("device", device.id);
    if (!active || active.revoked) throw new MobileFault(401, "device_revoked");
    if (active.revision !== device.revision) throw new MobileFault(410, "authorization_changed");
    const items = remaining.slice(0, limit);
    while (items.length > 1 && Buffer.byteLength(JSON.stringify(items)) > 480 * 1024) items.pop();
    const rest = remaining.slice(items.length);
    return {
      items,
      next: rest.length || nativeNext ? this.cursor(device, `${kind}:${entityId}`, view.snapshot.cursor, { remaining: rest, nativeNext, generation, entityId }) : null,
      generation,
      reset: false,
      sampledAt: this.store.now(),
      viewCursor: view.snapshot.cursor
    };
  }
  handle(req) {
    if (!this.available || !this.ready()) return this.dispatch(req);
    const work = this.dispatch(req).then((response) => this.available && this.ready() ? response : this.dispatch(req));
    this.inFlight.add(work);
    void work.then(() => this.inFlight.delete(work), () => this.inFlight.delete(work));
    return work;
  }
  async dispatch(req) {
    const requestId = randomUUID2(), headers = { "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff" };
    try {
      if (!this.available || !this.ready()) throw new MobileFault(503, "source_unavailable");
      const configuredOrigin = this.store.origins.find((o) => new URL(o).host === req.authority);
      if (!req.tls || !configuredOrigin) throw new MobileFault(403, "authority");
      if (req.headers.cookie || req.headers.origin && req.headers.origin !== configuredOrigin || req.headers["sec-fetch-site"] === "cross-site") throw new MobileFault(403, "origin");
      const url = new URL(req.path, configuredOrigin);
      if (url.origin !== configuredOrigin || !url.pathname.startsWith("/mobile/v1/")) throw new MobileFault(404, "not_found");
      const route = url.pathname.slice("/mobile/v1".length);
      for (const [key2] of url.searchParams) if (url.searchParams.getAll(key2).length !== 1) throw new MobileFault(400, "invalid_query");
      if (req.body && Buffer.byteLength(req.body) > 32 * 1024) throw new MobileFault(413, "body_too_large");
      if (req.method === "GET" && req.body) throw new MobileFault(400, "unexpected_body");
      const write = req.method !== "GET";
      const key = write || route.startsWith("/pairing/claims/") ? uuid.parse(req.headers["idempotency-key"]) : "";
      let body;
      if (req.body !== void 0 && req.body.length) {
        if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers["content-type"] ?? "")) throw new MobileFault(400, "json_required");
        try {
          body = JSON.parse(req.body);
        } catch {
          throw new MobileFault(400, "invalid_json");
        }
      }
      const reply = (status, result) => ({ status, headers, ...result === void 0 ? {} : { body: result } });
      const allowedQuery = (keys) => {
        for (const [key2] of url.searchParams) if (!keys.includes(key2)) throw new MobileFault(400, "invalid_query");
      };
      if (req.method === "GET" && route === "/hello") {
        allowedQuery([]);
        this.rate("hello:" + req.remoteAddress, 30);
        return reply(200, this.hello(req.pinning === true));
      }
      if (req.method === "POST" && route === "/pairing/claims") {
        allowedQuery([]);
        this.rate("pair:" + req.remoteAddress, 10);
        const args = external_exports.object({ invitationId: uuid, nonce: token, platform: external_exports.enum(["android", "ios"]), deviceName: external_exports.string().trim().min(1).max(80).regex(/^[^\x00-\x1f\x7f]+$/) }).strict().parse(body);
        return reply(202, this.store.claim(args.invitationId, args.nonce, args.deviceName, args.platform, key));
      }
      const claim = /^\/pairing\/claims\/([\w-]+)$/.exec(route);
      if (req.method === "GET" && claim) {
        allowedQuery([]);
        this.rate("poll:" + req.remoteAddress, 60);
        return reply(200, this.store.pollClaim(uuid.parse(claim[1]), this.bearer(req), key));
      }
      if (req.method === "POST" && route === "/auth/refresh") {
        allowedQuery([]);
        this.rate("refresh:" + req.remoteAddress, 30);
        if (body !== void 0) external_exports.object({}).strict().parse(body);
        return reply(200, this.store.refresh(this.bearer(req), req.headers["x-mobile-csrf"] ?? "", key));
      }
      const principal = this.store.authenticate(this.bearer(req)), device = principal.device;
      this.rate("device:" + device.id, 120);
      if (write) {
        this.store.checkCsrf(principal, req.headers["x-mobile-csrf"] ?? "");
        this.rate("write:" + device.id, 30);
      }
      if (req.method === "GET" && route === "/me") {
        allowedQuery([]);
        return reply(200, { deviceId: device.id, sessionId: principal.session.id, pcId: this.store.pcId, capabilities: [...new Set(device.grants.flatMap((g) => g.capabilities))], scopes: device.grants, accessExpiresAt: principal.session.accessExpiresAt, push: this.push.configured ? "configured" : "unsupported", pairedPcReads: "unsupported" });
      }
      if (req.method === "DELETE" && ["/me/session", "/me/push"].includes(route) || req.method === "PUT" && route === "/me/push") {
        allowedQuery([]);
        const args = req.method === "PUT" ? pushSchema.parse(body) : body === void 0 ? null : external_exports.object({}).strict().parse(body);
        const result = this.store.mutate(device.id, req.method + route, key, digest("body", JSON.stringify(args)), () => {
          if (route === "/me/session") this.store.revoke(device.id, "logout");
          else if (req.method === "DELETE") this.push.remove(device.id);
          const response = req.method === "PUT" ? this.push.register(device, args) : { state: "removed" };
          return { response, replay: response };
        });
        return reply(req.method === "PUT" ? 200 : 204, req.method === "PUT" ? result : void 0);
      }
      const view = await this.view(principal);
      if (req.method === "GET" && route === "/snapshot") {
        allowedQuery([]);
        this.recordWriteProof(principal, view.snapshot);
        return reply(200, view.snapshot);
      }
      if (req.method === "GET" && route === "/events") {
        allowedQuery(["after"]);
        const after = url.searchParams.get("after");
        if (!after) throw new MobileFault(400, "cursor_required");
        this.fromCursor(device, after, "events");
        const events = after === view.snapshot.cursor ? [] : [{ apiVersion: 1, epoch: this.epoch, cursor: view.snapshot.cursor, type: "snapshot.required", resource: { kind: "snapshot", id: this.store.pcId }, version: view.signature, at: view.snapshot.sampledAt }];
        return reply(200, { events, next: view.snapshot.cursor, sampledAt: view.snapshot.sampledAt, reset: events.length > 0 });
      }
      const list = route.slice(1);
      if (req.method === "GET" && ["sessions", "jobs", "questions"].includes(list)) {
        allowedQuery(list === "questions" ? ["cursor", "limit", "status"] : ["cursor", "limit"]);
        this.require(device, list === "questions" ? "questions.read" : "overview.read");
        const limit = this.limit(url), cursor = url.searchParams.get("cursor"), status = url.searchParams.get("status");
        if (status && !["open", "answered", "cancelled", "superseded"].includes(status)) throw new MobileFault(400, "invalid_status");
        const kind = `${list}${status ? ":" + status : ""}`;
        if (cursor) {
          const c = this.fromCursor(device, cursor, kind);
          if (c.viewCursor !== view.snapshot.cursor) throw new MobileFault(410, "snapshot_required");
          const payload = c.payload;
          return reply(200, this.collection(device, kind, payload.items, limit, view.snapshot.cursor, payload.offset, payload.generation));
        }
        const items = list === "sessions" ? view.all.sessions : list === "jobs" ? view.all.jobs : view.all.questions.filter((q) => !status || q.status === status);
        return reply(200, this.collection(device, kind, items, limit, view.snapshot.cursor));
      }
      const question = /^\/questions\/([\w-]+)(\/answer)?$/.exec(route);
      if (question) {
        allowedQuery([]);
        const q = view.all.questions.find((q2) => q2.id === question[1]);
        if (!q) throw new MobileFault(404, "not_found");
        if (req.method === "GET" && !question[2]) return reply(200, q);
        if (req.method === "POST" && question[2]) {
          const args = answerSchema.parse(body);
          if (q.status === "open" && q.version === args.expectedVersion && args.option && !q.options.some((o) => o.id === args.option)) throw new MobileFault(400, "unknown_option");
          const active = this.store.authenticate(this.bearer(req));
          this.store.checkCsrf(active, req.headers["x-mobile-csrf"] ?? "");
          if (active.device.revision !== device.revision) throw new MobileFault(410, "authorization_changed");
          if (!this.store.can(active.device, "questions.answer", q.pcId, { kind: "question", id: q.id, projectId: q.projectId }) || q.pcId !== this.store.pcId) throw new MobileFault(404, "not_found");
          this.requireWriteProof(active, req.headers["x-mobile-view"], view.snapshot);
          const result = await this.deadline(this.source.answer(q.id, args, device.id, key));
          return reply(200, { question: result, replayExpiresAt: this.store.now() + 24 * 60 * 6e4 });
        }
      }
      const chat = /^\/chats\/([\w-]+)$/.exec(route), steps = /^\/jobs\/([\w-]+)\/steps$/.exec(route);
      if (req.method === "GET" && (chat || steps)) {
        allowedQuery(["cursor", "limit"]);
        const entity = id.parse(chat?.[1] ?? steps?.[1]);
        return reply(200, await this.content(principal, view, entity, chat ? "chat" : "steps", url.searchParams.get("cursor"), this.limit(url)));
      }
      const hint = /^\/notifications\/([\w-]+)$/.exec(route);
      if (req.method === "GET" && hint) {
        allowedQuery([]);
        return reply(200, this.push.resolve(device, uuid.parse(hint[1]), view.all.questions));
      }
      throw new MobileFault(404, "unsupported");
    } catch (error) {
      if (!(error instanceof MobileFault) && !(error instanceof QuestionVersionConflict) && !(error instanceof external_exports.ZodError)) {
        try {
          this.diagnostics({ requestId, errorCategory: "unexpected_gateway_exception" });
        } catch {
        }
      }
      const fault = error instanceof MobileFault ? error : error instanceof QuestionVersionConflict ? new MobileFault(409, "version_conflict", error.currentVersion) : error instanceof external_exports.ZodError ? new MobileFault(400, "invalid_request") : new MobileFault(503, "source_unavailable");
      if (fault.status === 202) return { status: 202, headers, body: { state: "pending" } };
      return { status: fault.status, headers: { ...headers, ...fault.status === 429 ? { "retry-after": "60" } : {} }, body: { code: fault.code, message: fault.code.replaceAll("_", " "), requestId, retryable: fault.status === 503 || fault.status === 429, ...fault.currentVersion ? { currentVersion: fault.currentVersion } : {} } };
    }
  }
  bearer(req) {
    const match = /^Bearer ([A-Za-z0-9_-]{40,256})$/.exec(req.headers.authorization ?? "");
    if (!match) throw new MobileFault(401, "unauthorized");
    return match[1];
  }
  limit(url) {
    const raw = url.searchParams.get("limit") ?? "20";
    if (!/^\d{1,3}$/.test(raw) || Number(raw) < 1 || Number(raw) > 100) throw new MobileFault(400, "invalid_limit");
    return Number(raw);
  }
};

// src/mobile/bootstrap.ts
function provisionMobile(options) {
  if (!options.origins.length) throw new Error("Owner must provision LAN/Tailscale trusted HTTPS origins");
  const store = new MobileStore(options.registryFile, options.pcId, options.origins[0], Date.now, options.origins.slice(1), options.pins);
  let closed = false, closing;
  const ready = () => !closed && options.ready();
  const source = new LocalMobileSource(
    options.local,
    options.ownerQuestions.store,
    options.pcId,
    ready,
    (q) => options.ownerQuestions.complete(q),
    () => options.ownerQuestions.list()
  );
  const push = options.push ? new MobilePush(store, options.push.provider, options.push.encryptionKey, options.push.projectId, options.push.environment) : new MobilePush(store);
  const gateway = new MobileGateway(store, source, push, void 0, ready), desktopAdmin = new MobileDesktopAdmin(store, source, options.desktopOrigin, ready);
  let hintPoll;
  return { gateway, desktopAdmin, close: () => {
    if (closing) return closing;
    closed = true;
    gateway.deactivate();
    closing = (async () => {
      try {
        const settled = await Promise.allSettled([gateway.close(), hintPoll ?? Promise.resolve()]);
        const failed = settled[0];
        if (failed.status === "rejected") throw failed.reason;
      } finally {
        store.close();
      }
    })();
    return closing;
  }, pollQuestionHints: () => {
    if (hintPoll) return hintPoll;
    hintPoll = (async () => {
      if (!push.configured || !ready()) return;
      const view = await source.snapshot();
      for (const question of view.questions.filter((q) => q.status === "open")) {
        await push.notify(question, async () => {
          if (!ready()) return void 0;
          return (await source.snapshot()).questions.find((q) => q.id === question.id);
        });
      }
    })().finally(() => {
      hintPoll = void 0;
    });
    return hintPoll;
  } };
}

// src/mobile/https.ts
import { createServer } from "node:https";
function createMobileHttpsServer(gateway, tls, pinning = false) {
  if (!tls.key || !tls.cert) throw new Error("Owner-provisioned trusted TLS certificate/key required");
  const server = createServer({ ...tls, minVersion: "TLSv1.2" }, (req, res) => {
    const headers = {};
    for (const [key, value] of Object.entries(req.headers)) {
      if (Array.isArray(value)) {
        res.writeHead(400, { "cache-control": "no-store" });
        res.end();
        return;
      }
      headers[key] = value;
    }
    for (const header of ["authorization", "host", "origin", "idempotency-key", "x-mobile-csrf", "x-mobile-view", "content-type"])
      if (req.rawHeaders.filter((_, i) => i % 2 === 0 && req.rawHeaders[i].toLowerCase() === header).length > 1) {
        res.writeHead(400);
        res.end();
        return;
      }
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > 32 * 1024) {
        res.writeHead(413, { "cache-control": "no-store" });
        res.end();
        req.destroy();
      } else chunks.push(chunk);
    });
    req.on("end", () => {
      void gateway.handle({
        method: req.method ?? "",
        path: req.url ?? "",
        headers,
        body: chunks.length ? Buffer.concat(chunks).toString("utf8") : void 0,
        authority: req.headers.host ?? "",
        tls: true,
        pinning,
        remoteAddress: req.socket.remoteAddress ?? "unknown"
      }).then((result) => {
        const json = result.body === void 0 ? "" : JSON.stringify(result.body);
        if (Buffer.byteLength(json) > 512 * 1024) {
          res.writeHead(413, { "cache-control": "no-store" });
          res.end(JSON.stringify({ code: "response_too_large" }));
          return;
        }
        res.writeHead(result.status, result.headers);
        res.end(json);
      }).catch(() => {
        res.writeHead(503, { "cache-control": "no-store" });
        res.end(JSON.stringify({ code: "unavailable" }));
      });
    });
  });
  server.requestTimeout = 1e4;
  server.headersTimeout = 1e4;
  server.maxConnections = 32;
  return server;
}
function createMobileHttpsListeners(gateway, configs) {
  if (configs.length < 1 || configs.length > 8) throw new Error("Supply one to eight owner-provisioned private listeners");
  return configs.map((config) => {
    if (!gateway.store.origins.includes(config.origin) || !config.bindAddress || !Number.isInteger(config.port) || config.port < 1 || config.port > 65535 || ["0.0.0.0", "::"].includes(config.bindAddress)) throw new Error("Exact approved private bind address/hostname and HTTPS origin required");
    return { config, server: createMobileHttpsServer(gateway, config.tls, config.pinning === true) };
  });
}

// src/mobile/host.ts
async function prepareMobileDesktopHost(node, config) {
  const context = node.mobileHostContext();
  if (!context?.ready()) throw new MobileFault(503, "source_unavailable");
  let closed = false, closing, unregister = () => {
  };
  const ready = () => !closed && context.ready();
  const mobile = provisionMobile({ ...config, local: context.local, ownerQuestions: context.ownerQuestions, ready });
  let listeners = [];
  const close = () => {
    if (closing) return closing;
    closed = true;
    mobile.gateway.deactivate();
    closing = (async () => {
      const failures = [];
      try {
        const settled = await Promise.allSettled(listeners.map(({ server }) => new Promise((resolve, reject) => {
          server.closeAllConnections();
          if (!server.listening) {
            resolve();
            return;
          }
          server.close((error) => error ? reject(error) : resolve());
        })));
        for (const result of settled) if (result.status === "rejected") failures.push(result.reason);
      } finally {
        try {
          await mobile.close();
        } catch (error) {
          failures.push(error);
        } finally {
          unregister();
        }
      }
      if (failures.length) throw new AggregateError(failures, "mobile_host_disposal_failed");
    })();
    return closing;
  };
  try {
    if (config.listeners?.length) listeners = createMobileHttpsListeners(mobile.gateway, config.listeners);
    for (const { server } of listeners) server.on("listening", () => {
      if (!ready()) {
        server.closeAllConnections();
        server.close();
      }
    });
    unregister = context.onDispose(close);
    if (!ready()) throw new MobileFault(503, "source_unavailable");
    return { gateway: mobile.gateway, desktopAdmin: mobile.desktopAdmin, listeners, pollQuestionHints: mobile.pollQuestionHints, ready, close };
  } catch (error) {
    await close();
    throw error;
  }
}

// src/mobile/identity.ts
var import_reflect_metadata = __toESM(require_Reflect(), 1);
import { createHash as createHash2, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes as randomBytes2, randomUUID as randomUUID3, webcrypto } from "node:crypto";
import { promises as fs } from "node:fs";
import { dirname, isAbsolute, join, parse } from "node:path";
import { isIP } from "node:net";
var import_x509 = __toESM(require_x509_cjs(), 1);
var stateSchema = external_exports.object({ current: external_exports.string().uuid(), next: external_exports.string().uuid().optional() }).strict();
function spkiPin(key) {
  return createHash2("sha256").update(createPublicKey(key).export({ type: "spki", format: "der" })).digest("base64url");
}
async function privateDirectory(dir, policy) {
  if (!isAbsolute(dir)) throw new Error();
  let component = dir;
  while (component !== parse(component).root) {
    const info2 = await fs.lstat(component);
    if (info2.isSymbolicLink()) throw new Error();
    component = dirname(component);
  }
  const info = await fs.lstat(dir);
  if (!info.isDirectory() || ((policy.platform ?? process.platform) === "win32" ? !await (policy.acl ?? windowsPrivateAcl)(dir) : (info.mode & 63) !== 0 || typeof process.getuid === "function" && info.uid !== process.getuid())) throw new Error();
}
async function ensureDirectory(dir, policy) {
  let parent = dirname(dir);
  for (; ; ) {
    const info = await fs.lstat(parent);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error();
    if (parent === parse(parent).root) break;
    parent = dirname(parent);
  }
  try {
    await fs.mkdir(dir, { mode: 448 });
    protect(dir, 448, true);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  await privateDirectory(dir, policy);
}
async function writeNew(file, bytes, policy) {
  const handle = await fs.open(file, "wx", 384);
  try {
    protect(file, 384, true);
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await readPrivateMaterial(file, policy);
}
async function newKey(dir, policy) {
  const id2 = randomUUID3(), { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  await writeNew(join(dir, "keys", id2 + ".pem"), privateKey.export({ type: "pkcs8", format: "pem" }), policy);
  return id2;
}
async function keyBytes(dir, id2, policy) {
  const key = await readPrivateMaterial(join(dir, "keys", id2 + ".pem"), policy), parsed = createPrivateKey(key);
  if (parsed.asymmetricKeyType !== "ec" || parsed.asymmetricKeyDetails?.namedCurve !== "prime256v1") throw new Error();
  return key;
}
async function readState(dir, policy) {
  const names = (await fs.readdir(join(dir, "states"))).sort();
  if (names.some((name) => !/^\d{12}\.json$/.test(name))) throw new Error();
  if (!names.length) return { revision: 0 };
  const last = names.at(-1);
  return { state: stateSchema.parse(JSON.parse((await readPrivateMaterial(join(dir, "states", last), policy)).toString("utf8"))), revision: Number(last.slice(0, 12)) };
}
async function writeState(dir, revision, state, policy) {
  if (!Number.isSafeInteger(revision) || revision < 1 || revision >= 1e12) throw new Error();
  await writeNew(join(dir, "states", String(revision).padStart(12, "0") + ".json"), JSON.stringify(state), policy);
}
async function certificate(key, origins, now) {
  const hosts = [...new Set(origins.map((origin) => {
    const url = new URL(origin);
    if (url.protocol !== "https:" || url.origin !== origin || url.username || url.password) throw new Error();
    return url.hostname.replace(/^\[|\]$/g, "");
  }))];
  if (!hosts.length || hosts.length > 8) throw new Error();
  const algorithm = { name: "ECDSA", namedCurve: "P-256", hash: "SHA-256" };
  const privateKey = await webcrypto.subtle.importKey("pkcs8", createPrivateKey(key).export({ type: "pkcs8", format: "der" }), algorithm, false, ["sign"]);
  const publicKey = await webcrypto.subtle.importKey("spki", createPublicKey(key).export({ type: "spki", format: "der" }), algorithm, true, ["verify"]);
  const cert = await import_x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: randomBytes2(16).toString("hex"),
    name: "CN=agent-bridge mobile",
    keys: { privateKey, publicKey },
    signingAlgorithm: algorithm,
    notBefore: new Date(Math.floor((now - 3e5) / 1e3) * 1e3),
    notAfter: new Date(Math.floor((now + 365 * 864e5) / 1e3) * 1e3),
    extensions: [
      new import_x509.BasicConstraintsExtension(false, void 0, true),
      new import_x509.KeyUsagesExtension(import_x509.KeyUsageFlags.digitalSignature, true),
      new import_x509.ExtendedKeyUsageExtension(["1.3.6.1.5.5.7.3.1"]),
      new import_x509.SubjectAlternativeNameExtension(hosts.map((value) => ({ type: isIP(value) ? "ip" : "dns", value })))
    ]
  }, webcrypto);
  return Buffer.from(cert.toString("pem"));
}
var inFlight = /* @__PURE__ */ new Map();
function loadMobileIdentity(home, origins, options = {}) {
  const dir = join(home, "mobile-identity");
  if (inFlight.has(dir)) return Promise.reject(new MobileActivationFault("material_unavailable"));
  const work = (async () => {
    try {
      await ensureDirectory(dir, options);
      for (const child of ["keys", "states", "archive"]) await ensureDirectory(join(dir, child), options);
      let { state, revision } = await readState(dir, options);
      if (!state) {
        if ((await fs.readdir(join(dir, "keys"))).length || options.rotation) throw new Error();
        state = { current: await newKey(dir, options) };
        await writeState(dir, ++revision, state, options);
      }
      const current = await keyBytes(dir, state.current, options);
      if (options.rotation === "stage" && !state.next) {
        state = { ...state, next: await newKey(dir, options) };
        await writeState(dir, ++revision, state, options);
      }
      if (options.rotation === "promote") {
        if (!state.next) throw new Error();
        await keyBytes(dir, state.next, options);
        const archived = join(dir, "archive", state.current + ".pem");
        try {
          await writeNew(archived, current, options);
        } catch (error) {
          if (error.code !== "EEXIST" || !(await readPrivateMaterial(archived, options)).equals(current)) throw error;
        }
        state = { current: state.next };
        await writeState(dir, ++revision, state, options);
      }
      const key = await keyBytes(dir, state.current, options), pins = [spkiPin(key)];
      if (state.next) pins.push(spkiPin(await keyBytes(dir, state.next, options)));
      return { key, cert: await certificate(key, origins, options.now ?? Date.now()), pins };
    } catch {
      throw new MobileActivationFault("material_unavailable");
    }
  })().finally(() => {
    inFlight.delete(dir);
  });
  inFlight.set(dir, work);
  return work;
}

// src/mobile/activation.ts
function validateMobileTls(cert, key, hostname) {
  try {
    const x509 = new X509Certificate(cert), now = Date.now(), from = Date.parse(x509.validFrom), to = Date.parse(x509.validTo);
    hostname = hostname.replace(/^\[|\]$/g, "");
    if (!Number.isFinite(from) || !Number.isFinite(to) || now < from || now >= to || !x509.checkPrivateKey(createPrivateKey2(key)) || !(isIP2(hostname) ? x509.checkIP(hostname) : x509.checkHost(hostname, { wildcards: false }))) throw new Error();
  } catch {
    throw new MobileActivationFault("tls_invalid");
  }
}
var MobileActivation = class {
  constructor(node, config, options, deps = {}) {
    this.node = node;
    this.config = config;
    this.options = options;
    this.deps = deps;
  }
  node;
  config;
  options;
  deps;
  starting;
  closing;
  retiring;
  disposal;
  prepared;
  desktop;
  unregister;
  poll;
  retired = false;
  state = "preparing";
  status = () => this.state === "ready" && !this.prepared?.ready() ? "source_unavailable" : this.state;
  start() {
    return this.starting ??= this.open();
  }
  diagnostic(errorCategory) {
    try {
      this.options.log.warn("mobile unavailable", { requestId: randomUUID4(), errorCategory });
    } catch {
    }
  }
  async open() {
    try {
      if ("invalid" in this.config) throw new MobileActivationFault("config_invalid");
      if (!Number.isInteger(this.options.port) || this.options.port < 1 || this.options.port > 65535) throw new MobileActivationFault("config_invalid");
      if (!this.node.isBroker || this.retired) throw new MobileActivationFault("source_unavailable");
      const material = this.deps.material ?? readPrivateMaterial;
      const listeners = [];
      let identity;
      for (const listener of this.config.listeners) {
        const addresses = isIP2(listener.bindAddress) ? [listener.bindAddress] : await (this.deps.addresses ?? (async (name) => (await lookup(name, { all: true })).map((r) => r.address)))(listener.bindAddress);
        if (!addresses.length || addresses.some((address) => !privateAddress(address))) throw new MobileActivationFault("bind_invalid");
        const pinned = "tls" in listener;
        if (pinned) identity ??= await (this.deps.identity ?? loadMobileIdentity)(this.options.home, this.config.origins);
        const cert = pinned ? identity.cert : await material(listener.certFile), key = pinned ? identity.key : await material(listener.keyFile);
        (this.deps.validateTls ?? validateMobileTls)(cert, key, new URL(listener.origin).hostname);
        listeners.push({ origin: listener.origin, bindAddress: addresses[0], port: listener.port, tls: { cert, key }, ...pinned ? { pinning: true } : {} });
      }
      let push;
      if (this.config.push) {
        try {
          const raw = await material(this.config.push.materialRef), parsed = JSON.parse(raw.toString("utf8"));
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
          const value = parsed;
          if (Object.keys(value).sort().join(",") !== "accessToken,encryptionKey" || typeof value.accessToken !== "string" || !value.accessToken || value.accessToken.length > 4096 || /[\r\n]/.test(value.accessToken) || typeof value.encryptionKey !== "string") throw new Error();
          const encryptionKey = Buffer.from(value.encryptionKey, "base64");
          if (encryptionKey.length !== 32 || encryptionKey.toString("base64") !== value.encryptionKey) throw new Error();
          push = {
            provider: (this.deps.provider ?? ((token2) => new ExpoPushProvider(token2)))(value.accessToken),
            encryptionKey,
            projectId: this.config.push.projectId,
            environment: this.config.push.environment
          };
          raw.fill(0);
        } catch {
          throw new MobileActivationFault("material_unavailable");
        }
      }
      if (this.retired || !this.node.initializeMobileOwnerQuestions()) throw new MobileActivationFault("source_unavailable");
      this.prepared = await (this.deps.prepare ?? prepareMobileDesktopHost)(this.node, {
        registryFile: join2(this.options.home, "mobile.db"),
        pcId: this.config.pcId,
        origins: this.config.origins,
        desktopOrigin: `http://127.0.0.1:${this.options.port}`,
        listeners,
        ...identity ? { pins: identity.pins } : {},
        ...push ? { push } : {}
      });
      if (this.retired || !this.prepared.ready()) throw new MobileActivationFault("source_unavailable");
      const context = this.node.mobileHostContext();
      if (!context?.ready()) throw new MobileActivationFault("source_unavailable");
      this.unregister = context.onDispose(() => this.retireMobile());
      const factory = this.deps.desktop ?? ((options) => {
        throw new Error("desktop_factory_required");
      });
      this.desktop = factory({ ...this.options, mobileAdmin: this.prepared.desktopAdmin, mobileStatus: this.status });
      const info = await this.desktop.ensure();
      for (const { config, server } of this.prepared.listeners) {
        if (this.retired || !this.prepared.ready()) throw new MobileActivationFault("source_unavailable");
        await new Promise((resolve, reject) => {
          const cleanup = () => {
            clearTimeout(timer);
            server.off("error", failed);
            server.off("listening", done);
          };
          const done = () => {
            cleanup();
            resolve();
          }, failed = () => {
            cleanup();
            reject(new MobileActivationFault("restart_required"));
          };
          const timer = setTimeout(failed, 5e3);
          server.once("error", failed);
          server.once("listening", done);
          try {
            server.listen(config.port, config.bindAddress);
          } catch {
            failed();
          }
        });
        server.on("error", () => {
          this.state = "restart_required";
          this.diagnostic(this.state);
          void this.retireMobile();
        });
      }
      if (this.retired || !this.prepared.ready()) throw new MobileActivationFault("source_unavailable");
      this.state = "ready";
      if (push) {
        this.poll = setInterval(() => {
          if (this.status() === "ready") void this.prepared?.pollQuestionHints().catch(() => this.diagnostic("source_unavailable"));
        }, 2e3);
        this.poll.unref();
      }
      return info;
    } catch (error) {
      this.state = error instanceof MobileActivationFault ? error.category : "restart_required";
      this.diagnostic(this.state);
      this.retired = true;
      await this.disposeOwned();
      return void 0;
    }
  }
  close() {
    if (this.closing) return this.closing;
    void this.retireMobile();
    this.closing = this.disposeOwned();
    return this.closing;
  }
  retireMobile() {
    if (this.retiring) return this.retiring;
    this.retired = true;
    if (this.state === "ready" || this.state === "preparing") this.state = "source_unavailable";
    if (this.poll) clearInterval(this.poll);
    this.poll = void 0;
    this.prepared?.gateway.deactivate();
    this.retiring = this.disposeOwned(false);
    return this.retiring;
  }
  disposeOwned(closeDesktop = true) {
    const prepared = this.prepared, desktop = this.desktop;
    if (this.disposal && this.disposal.prepared === prepared && this.disposal.desktop === desktop && this.disposal.closeDesktop === closeDesktop) return this.disposal.work;
    const work = this.settleOwned(prepared, closeDesktop ? desktop : void 0, this.unregister);
    this.disposal = { prepared, desktop, closeDesktop, work };
    return work;
  }
  async settleOwned(prepared, desktop, unregister) {
    prepared?.gateway.deactivate();
    let timer;
    try {
      const settled = await Promise.race([
        Promise.allSettled([prepared?.close() ?? Promise.resolve(), desktop?.close() ?? Promise.resolve()]),
        new Promise((resolve) => {
          timer = setTimeout(() => resolve(void 0), 5e3);
        })
      ]);
      if (!settled || settled.some((r) => r.status === "rejected")) {
        this.state = "restart_required";
        this.diagnostic(this.state);
      }
    } finally {
      if (timer) clearTimeout(timer);
      unregister?.();
      if (this.unregister === unregister) this.unregister = void 0;
    }
  }
};
async function configuredMobileDashboard(node, config, options, deps = {}) {
  if (!config) return void 0;
  const desktop = deps.desktop ?? (await import("./dashboard-KTVOEAYC.mjs")).createConfiguredMobileDashboard;
  return new MobileActivation(node, config, options, { ...deps, desktop });
}
export {
  MobileActivation,
  configuredMobileDashboard,
  validateMobileTls
};
/*! Bundled license information:

reflect-metadata/Reflect.js:
  (*! *****************************************************************************
  Copyright (C) Microsoft. All rights reserved.
  Licensed under the Apache License, Version 2.0 (the "License"); you may not use
  this file except in compliance with the License. You may obtain a copy of the
  License at http://www.apache.org/licenses/LICENSE-2.0
  
  THIS CODE IS PROVIDED ON AN *AS IS* BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
  KIND, EITHER EXPRESS OR IMPLIED, INCLUDING WITHOUT LIMITATION ANY IMPLIED
  WARRANTIES OR CONDITIONS OF TITLE, FITNESS FOR A PARTICULAR PURPOSE,
  MERCHANTABLITY OR NON-INFRINGEMENT.
  
  See the Apache Version 2.0 License for specific language governing permissions
  and limitations under the License.
  ***************************************************************************** *)

pvtsutils/build/index.js:
  (*!
   * MIT License
   * 
   * Copyright (c) 2017-2024 Peculiar Ventures, LLC
   * 
   * Permission is hereby granted, free of charge, to any person obtaining a copy
   * of this software and associated documentation files (the "Software"), to deal
   * in the Software without restriction, including without limitation the rights
   * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
   * copies of the Software, and to permit persons to whom the Software is
   * furnished to do so, subject to the following conditions:
   * 
   * The above copyright notice and this permission notice shall be included in all
   * copies or substantial portions of the Software.
   * 
   * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
   * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
   * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
   * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
   * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
   * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
   * SOFTWARE.
   * 
   *)

pvutils/build/utils.js:
  (*!
   Copyright (c) Peculiar Ventures, LLC
  *)

asn1js/build/index.js:
  (*!
   * Copyright (c) 2014, GMO GlobalSign
   * Copyright (c) 2015-2022, Peculiar Ventures
   * All rights reserved.
   * 
   * Author 2014-2019, Yury Strozhevsky
   * 
   * Redistribution and use in source and binary forms, with or without modification,
   * are permitted provided that the following conditions are met:
   * 
   * * Redistributions of source code must retain the above copyright notice, this
   *   list of conditions and the following disclaimer.
   * 
   * * Redistributions in binary form must reproduce the above copyright notice, this
   *   list of conditions and the following disclaimer in the documentation and/or
   *   other materials provided with the distribution.
   * 
   * * Neither the name of the copyright holder nor the names of its
   *   contributors may be used to endorse or promote products derived from
   *   this software without specific prior written permission.
   * 
   * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
   * ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
   * WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
   * DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR
   * ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES
   * (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES;
   * LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON
   * ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
   * (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS
   * SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
   * 
   *)

tslib/tslib.es6.js:
  (*! *****************************************************************************
  Copyright (c) Microsoft Corporation.
  
  Permission to use, copy, modify, and/or distribute this software for any
  purpose with or without fee is hereby granted.
  
  THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
  REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY
  AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
  INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM
  LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR
  OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR
  PERFORMANCE OF THIS SOFTWARE.
  ***************************************************************************** *)

@peculiar/x509/build/x509.cjs.js:
  (*!
   * MIT License
   * 
   * Copyright (c) Peculiar Ventures. All rights reserved.
   * 
   * Permission is hereby granted, free of charge, to any person obtaining a copy
   * of this software and associated documentation files (the "Software"), to deal
   * in the Software without restriction, including without limitation the rights
   * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
   * copies of the Software, and to permit persons to whom the Software is
   * furnished to do so, subject to the following conditions:
   * 
   * The above copyright notice and this permission notice shall be included in all
   * copies or substantial portions of the Software.
   * 
   * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
   * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
   * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
   * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
   * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
   * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
   * SOFTWARE.
   * 
   *)
*/
