// ============================================================
// Code-generation of template tags

// The `CodeGen` class currently has no instance state, but in theory
// it could be useful to track per-function state, like whether we
// need to emit `var self = this` or not.
var CodeGen = SpacebarsCompiler.CodeGen = function () {};

var builtInBlockHelpers = SpacebarsCompiler._builtInBlockHelpers = {
  'if': 'Blaze.If',
  'unless': 'Blaze.Unless',
  'with': 'Spacebars.With2',
  'each': 'Spacebars.Each'
};


// Some `UI.*` paths are special in that they generate code that
 // doesn't folow the normal lookup rules for dotted symbols. The
 // following names must be prefixed with `UI.` when you use them in a
 // template.
var builtInUIPaths = {
  // `template` is a local variable defined in the generated render
  // function for the template in which `UI.contentBlock` (or
  // `UI.elseBlock`) is invoked. `template` is a reference to the
  // template itself.
  'contentBlock': 'self.__contentBlock',
  'elseBlock': 'self.__elseBlock',

  // `Template` is the global template namespace. If you define a
  // template named `foo` in Spacebars, it gets defined as
  // `Template.foo` in JavaScript.
  'dynamic': 'Template.__dynamic'
};

// A "reserved name" can't be used as a <template> name.  This
// function is used by the template file scanner.
SpacebarsCompiler.isReservedName = function (name) {
  return builtInBlockHelpers.hasOwnProperty(name);
};

var makeObjectLiteral = function (obj) {
  var parts = [];
  for (var k in obj)
    parts.push(BlazeTools.toObjectLiteralKey(k) + ': ' + obj[k]);
  return '{' + parts.join(', ') + '}';
};

_.extend(CodeGen.prototype, {
  codeGenTemplateTag: function (tag) {
    var self = this;
    if (tag.position === HTMLTools.TEMPLATE_TAG_POSITION.IN_START_TAG) {
      // Special dynamic attributes: `<div {{attrs}}>...`
      // only `tag.type === 'DOUBLE'` allowed (by earlier validation)
      return BlazeTools.EmitCode(
        'Blaze.Var(function () { return ' +
          self.codeGenMustache(tag.path, tag.args, 'attrMustache')
          + '; })');
    } else {
      if (tag.type === 'DOUBLE') {
        return BlazeTools.EmitCode('Blaze.Isolate(function () { return ' +
                                   self.codeGenMustache(tag.path, tag.args) + '; })');
      } else if (tag.type === 'TRIPLE') {
        return BlazeTools.EmitCode('Blaze.Isolate(function () { return Spacebars.makeRaw(' +
                                   self.codeGenMustache(tag.path, tag.args) + '); })');
      } else if (tag.type === 'INCLUSION' || tag.type === 'BLOCKOPEN') {
        var path = tag.path;

        if (tag.type === 'BLOCKOPEN' &&
            builtInBlockHelpers.hasOwnProperty(path[0])) {
          // if, unless, with, each.
          //
          // If someone tries to do `{{> if}}`, we don't
          // get here, but an error is thrown when we try to codegen the path.

          // Note: If we caught these errors earlier, while scanning, we'd be able to
          // provide nice line numbers.
          if (path.length > 1)
            throw new Error("Unexpected dotted path beginning with " + path[0]);
          if (! tag.args.length)
            throw new Error("#" + path[0] + " requires an argument");

          // `args` must exist (tag.args.length > 0)
          var dataCode = self.codeGenInclusionDataFunc(tag.args) || 'null';
          // `content` must exist
          var contentBlock = (('content' in tag) ?
                              self.codeGenBlock(tag.content) : null);
          // `elseContent` may not exist
          var elseContentBlock = (('elseContent' in tag) ?
                                  self.codeGenBlock(tag.elseContent) : null);

          var callArgs = [dataCode, contentBlock];
          if (elseContentBlock)
            callArgs.push(elseContentBlock);

          return BlazeTools.EmitCode(
            builtInBlockHelpers[path[0]] + '(' + callArgs.join(', ') + ')');

        } else {
          var compCode = self.codeGenPath(path, {lookupTemplate: true});
          if (path.length > 1) {
            // capture reactivity
            compCode = 'function () { return Spacebars.call(' + compCode +
              '); }';
          }

          var dataCode = self.codeGenInclusionDataFunc(tag.args);
          var content = (('content' in tag) ?
                         self.codeGenBlock(tag.content) : null);
          var elseContent = (('elseContent' in tag) ?
                             self.codeGenBlock(tag.elseContent) : null);

          var includeArgs = [compCode];
          if (content) {
            includeArgs.push(content);
            if (elseContent)
              includeArgs.push(elseContent);
          }

          var includeCode =
                'Spacebars.include2(' + includeArgs.join(', ') + ')';

          // calling convention compat -- set the data context around the
          // entire inclusion, so that if the name of the inclusion is
          // a helper function, it gets the data context in `this`.
          // This makes for a pretty confusing calling convention --
          // In `{{#foo bar}}`, `foo` is evaluated in the context of `bar`
          // -- but it's what we shipped for 0.8.0.  The rationale is that
          // `{{#foo bar}}` is sugar for `{{#with bar}}{{#foo}}...`.
          if (dataCode) {
            includeCode =
              'Spacebars.TemplateWith(' + dataCode + ', function () { return ' +
              includeCode + '; })';
          }

          /*if (path[0] === 'UI' &&
              (path[1] === 'contentBlock' || path[1] === 'elseBlock')) {
            includeCode = 'UI.InTemplateScope(template, ' + includeCode + ')';
          }*/

          return BlazeTools.EmitCode(includeCode);
        }
      } else {
        // Can't get here; TemplateTag validation should catch any
        // inappropriate tag types that might come out of the parser.
        throw new Error("Unexpected template tag type: " + tag.type);
      }
    }
  },

  // `path` is an array of at least one string.
  //
  // If `path.length > 1`, the generated code may be reactive
  // (i.e. it may invalidate the current computation).
  //
  // No code is generated to call the result if it's a function.
  //
  // Options:
  //
  // - lookupTemplate {Boolean} If true, generated code also looks in
  //   the list of templates. (After helpers, before data context).
  //   Used when generating code for `{{> foo}}` or `{{#foo}}`. Only
  //   used for non-dotted paths.
  codeGenPath: function (path, opts) {
    if (builtInBlockHelpers.hasOwnProperty(path[0]))
      throw new Error("Can't use the built-in '" + path[0] + "' here");
    // Let `{{#if UI.contentBlock}}` check whether this template was invoked via
    // inclusion or as a block helper, in addition to supporting
    // `{{> UI.contentBlock}}`.
    if (path.length >= 2 &&
        path[0] === 'UI' && builtInUIPaths.hasOwnProperty(path[1])) {
      if (path.length > 2)
        throw new Error("Unexpected dotted path beginning with " +
                        path[0] + '.' + path[1]);
      return builtInUIPaths[path[1]];
    }

    var args = [BlazeTools.toJSLiteral(path[0]), 'self'];
    var lookupMethod = 'lookup';
    if (opts && opts.lookupTemplate && path.length === 1)
      lookupMethod = 'lookupTemplate';
    var code = 'Blaze.' + lookupMethod + '(' + args.join(', ') + ')';

    if (path.length > 1) {
      code = 'Spacebars.dot(' + code + ', ' +
        _.map(path.slice(1), BlazeTools.toJSLiteral).join(', ') + ')';
    }

    return code;
  },

  // Generates code for an `[argType, argValue]` argument spec,
  // ignoring the third element (keyword argument name) if present.
  //
  // The resulting code may be reactive (in the case of a PATH of
  // more than one element) and is not wrapped in a closure.
  codeGenArgValue: function (arg) {
    var self = this;

    var argType = arg[0];
    var argValue = arg[1];

    var argCode;
    switch (argType) {
    case 'STRING':
    case 'NUMBER':
    case 'BOOLEAN':
    case 'NULL':
      argCode = BlazeTools.toJSLiteral(argValue);
      break;
    case 'PATH':
      argCode = self.codeGenPath(argValue);
      break;
    default:
      // can't get here
      throw new Error("Unexpected arg type: " + argType);
    }

    return argCode;
  },

  // Generates a call to `Spacebars.fooMustache` on evaluated arguments.
  // The resulting code has no function literals and must be wrapped in
  // one for fine-grained reactivity.
  codeGenMustache: function (path, args, mustacheType) {
    var self = this;

    var nameCode = self.codeGenPath(path);
    var argCode = self.codeGenMustacheArgs(args);
    var mustache = (mustacheType || 'mustache');

    return 'Spacebars.' + mustache + '(' + nameCode +
      (argCode ? ', ' + argCode.join(', ') : '') + ')';
  },

  // returns: array of source strings, or null if no
  // args at all.
  codeGenMustacheArgs: function (tagArgs) {
    var self = this;

    var kwArgs = null; // source -> source
    var args = null; // [source]

    // tagArgs may be null
    _.each(tagArgs, function (arg) {
      var argCode = self.codeGenArgValue(arg);

      if (arg.length > 2) {
        // keyword argument (represented as [type, value, name])
        kwArgs = (kwArgs || {});
        kwArgs[arg[2]] = argCode;
      } else {
        // positional argument
        args = (args || []);
        args.push(argCode);
      }
    });

    // put kwArgs in options dictionary at end of args
    if (kwArgs) {
      args = (args || []);
      args.push('Spacebars.kw(' + makeObjectLiteral(kwArgs) + ')');
    }

    return args;
  },

  codeGenBlock: function (content) {
    return SpacebarsCompiler.codeGen(content);
  },

  codeGenInclusionDataFunc: function (args) {
    var self = this;

    var dataFuncCode = null;

    if (! args.length) {
      // e.g. `{{#foo}}`
      return null;
    } else if (args[0].length === 3) {
      // keyword arguments only, e.g. `{{> point x=1 y=2}}`
      var dataProps = {};
      _.each(args, function (arg) {
        var argKey = arg[2];
        dataProps[argKey] = 'Spacebars.call(' + self.codeGenArgValue(arg) + ')';
      });
      dataFuncCode = makeObjectLiteral(dataProps);
    } else if (args[0][0] !== 'PATH') {
      // literal first argument, e.g. `{{> foo "blah"}}`
      //
      // tag validation has confirmed, in this case, that there is only
      // one argument (`args.length === 1`)
      dataFuncCode = self.codeGenArgValue(args[0]);
    } else if (args.length === 1) {
      // one argument, must be a PATH
      dataFuncCode = 'Spacebars.call(' + self.codeGenPath(args[0][1]) + ')';
    } else {
      // Multiple positional arguments; treat them as a nested
      // "data mustache"
      dataFuncCode = self.codeGenMustache(args[0][1], args.slice(1),
                                          'dataMustache');
    }

    return 'function () { return ' + dataFuncCode + '; }';
  }

});
