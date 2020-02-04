const fs     = require('fs')
const path   = require('path')
const script = require('../assets/nexrender.jsx')

/* helpers */
const escape = str => {
    str = JSON.stringify(str)
    str = str.substring(1, str.length-1)
    str = `'${str.replace(/\'/g, '\\\'')}'`
    return str
}

const selectLayers = ({ composition, layerName, layerIndex }, callbackString) => {
    const method = layerName ? 'selectLayersByName' : 'selectLayersByIndex';
    const compo  = composition === undefined ? 'null' : escape(composition);
    const value  = layerName ? escape(layerName) : layerIndex;

    return (`nexrender.${method}(${compo}, ${value}, ${callbackString});`);
}

const renderIf = (value, string) => {
    const encoded = typeof value == 'string' ? escape(value) : JSON.stringify(value);
    return value === undefined ? '' : string.replace('$value', encoded);
}

const partsOfKeypath = (keypath) => {
    var parts = keypath.split('->');
    return (parts.length === 1) ? keypath.split('.') : parts
}

/* scripting wrappers */
const wrapFootage = ({ dest, ...asset }) => (`(function() {
    ${selectLayers(asset, `function(layer) {
        nexrender.replaceFootage(layer, '${dest.replace(/\\/g, "\\\\")}')
    }`)}
})();\n`)

const wrapData = ({ property, value, expression, ...asset }) => (`(function() {
    ${selectLayers(asset, /* syntax:js */`function(layer) {

        var parts = ${JSON.stringify(partsOfKeypath(property))};
        ${renderIf(value, `var value = { "value": $value }`)}
        ${renderIf(expression, `var value = { "expression": $value }`)}
        nexrender.changeValueForKeypath(layer, parts, value);

        return true;
    }`)}
})();\n`)

// @deprecated in favor of wrapEnhancedScript (implementation below)
const wrapScript = ({ dest }) => (`(function() {
    ${fs.readFileSync(dest, 'utf8')}
})();\n`)


/*
    Wrap Enhanced Script
    ====================
    @author Dilip Ramírez (https://github.com/dukuo | https://notimetoexplain.co)
    @description        Parse a script from a source, and injects a configuration object named ${keyword} based on the "parameters" array of the script asset if any. 

                        If parameters or functions deriving from the configuration object are being used in the script, but no parameters are set, then it succeeds but 
                        displays a warning with the missing JSX/JSON matches, and sets all the missing ones to null for a soft fault tolerance at runtime. 
                        
                        Example JSON asset declaration:
                        
                        "assets": [
                            {
                                "src": "file:///C:/sample/sampleParamInjection.jsx",
                                "type": "script",
                                "parameters": [
                                    {
                                        "key": "name",
                                        "value": "Dilip"
                                    }
                                ]
                            }
                        ]

                        By default ${keyword} = "NX", so you would use a dynamic variable like NX.name or a function like NX.something(). To change this keyword simply
                        set "keyword" as shown below: 

                        "assets": [
                            {
                                "src": "file:///C:/sample/sampleParamInjection.jsx",
                                "type": "script",
                                "keyword": "_settings",
                                "parameters": [
                                    {
                                        "key": "name",
                                        "value": "Dilip"
                                    }
                                ]
                            }
                        ]

                        That way instead of NX.name it would be _settings.name

                        All dynamic parameters used in the script should have a JSX default by stating a local ${keyword} variable like on the example below.

                        Example JSX Script with defaults:

                        {
                            var NX = NX || { name : John }; // Setting default variables.

                            return "Hello " + NX.name;
                        }

                        The code above will output either:
                        a) "Hello John" if no parameter defined on the JSON "parameters" array.
                        b) "Hello NAME" if parameter "name" has a "value" of NAME on the JSON "parameters" array. 

                        Example JSX Script without defaults:

                        {
                            return "There are " + NX.beerBottlesAmount + " beer bottles ready to drink!"
                        }

                        The code above will output either:
                        a) "There are null beer bottles ready to drink!" if no parameter defined on the JSON Asset "parameters" array.
                        b) "There are X beer bottles ready to drink!" if parameter "beerBottlesAmount" has a "value" of X on the JSON Asset "parameters" array. 

    @param src                 The JSX script 
    @param parameters          (Array<Object>) Argument array described in the Asset JSON object inside the Job description
    @param keyword             (String) Name for the exported variable holding configuration parameters. Defaults to NX as in NeXrender.

    @return string             (String) The compiled script with parameter injection outside its original scope to avoid user-defined defaults collision. 
*/
const wrapEnhancedScript = ({ dest, parameters = [], keyword = "NX",  ...asset }, jobID, settings) => {
    // Initialization 

    // Byte stream from download.js helper. Not to be confused  with src which is the plaintext path to the file. 
    var script = fs.readFileSync(dest, 'utf8');
    
    // Parameter argument injection template literal. See at the end for the final definition. 
    var argumentInjection = "";
    
    // Regular Expression to match all {keyword} occurrences. For example, if keyword==NX then it matches variables such as NX.sample or functions such as NX.call()

    // The following regex is just for reference purposes, since the lookbehind part is not currently working.
    // (NX\.)([a-zA-Z0-9_-]{1,}[\(]?(?(?<=\()\)|[a-zA-Z0-9_\-\(\),.]{1,}\))?)?
    var regex = new RegExp(`(${keyword}\\.)([a-zA-Z0-9_-]{1,}[\\(]?)?`, "gm");

    // Keys of the missing parameters. See below for further explanation.
    var missingMatches = {
        fn: [],
        vars: [],
        needsDefault: [],
    };

    // Helper functions

    /*
        Setup Parameter Injection
        ==========================
        @description            Creates the string initializing a scoped variable with parameters from either the Script Asset JSON configuration or a placeholder array with null values 
                                by finding uses of the ${keyword} variable in the JSX script provided that the user didn't define its own default values. 
        @param keyword          (String) Keyword to define as the final variable name. Defaults to NX as in NeXrender.
        @param parameters       (Object) Object with the parameters to inject. Defaults to {}
        @param script           (string) JSX Script to inject the variable to.
        @param logger           (Object) Logger to output warning. Defaults to global logger (console)
        @return string          (String) Final template literal to place at the compiled script. 
    */

   const setupInjection = (keyword, parameters, script, logger ) => {
    var str = ``;
    var injectedParams = {};

    // Regex to find a local scoped instance of ${keyword}, to avoid overriding local defaults with null values. 
    var regx = new RegExp(`(var|const|let) ${keyword}`, "gm");

    // And we finally inject the parameters to the script outside the script scope to avoid conflicts with user-defined defaults.
    // If no parameter is set in the JSON declaration, and no default initialization is defined in the script then we inject an object with nulled missing parameters.
    if(Object.keys(parameters).length > 0) {
        parameters.forEach(p => injectedParams[p.key] = p.value);
        str = `var ${keyword} = ${JSON.stringify(injectedParams)};`;
    } else if( script.match(regx) == null) {
        // Fill with null all the missing arguments currently being used in the JSX script but not defined on the JSON Asset.
        str = `var ${keyword} = ${JSON.stringify(fillObject(missingMatches.needsDefault, injectedParams))}`;
    } 

    if(Object.keys(parameters).length == 0) {
        logger.log(`[${jobID}] ${displayAlert(missingMatches, script.match(regx) == null, str)}`);
    }
    

    return str;
}
    
    /*
        Generated Placeholder Parameters
        ================================
        @description            Generates placeholder a "parameters" JSON Object based on keys from an array.
        @param keys             (Array) Array of strings.

        @return string          (String) JSON "parameters" object.   
    */
    var generatedPlaceholderParameters = (keys = []) => {
        const template = (key) => `
                {
                    "${key}"  :   "null"
                }\n
        `;

        return `
            "parameters" : [
                ${keys.map((k, i) => `${template(k)}${Object.keys(keys).length - 1 != i ? "," : ""}`).join()}
            ]
        `
    }
    /*
        Display Missing Alert
        =====================
        @description              Display a log message if theres any missing parameter set on the JSON configuration but is being referred in the script.
        
        Parameters:
        @param m                 (Object) Missing Parameters object. See below for its construction. Must have child objects `fn` and `vars`
        @param showJSXWarning    (Boolean) Flag for whether or not to display warning about not initializing variable in JSX script. Defaults to false.
        @param injectionVar      (String) Variable initialized with placeholder values. Defaults to "".

        @return string           (String) The template literal string displaying all the occurences if any. 
    */
    var displayAlert = (m, showJSXWarning = false, injectionVar = "") => {
        const areFnMissing = (m.fn != undefined && Object.keys(m.fn).length > 0);
        const areVarsMissing = (m.vars != undefined && Object.keys(m.vars).length > 0);

        return ` -- W A R N I N G --
        The following ${areVarsMissing ? 'variables ' : "" }${areVarsMissing && areFnMissing ? 'and ' : "" }${areFnMissing ? 'functions ' : "" }on the script are not defined in the Asset JSON configuration:
        ${areFnMissing ? `Functions: ${m.fn.join(",")}` : ""}
        ${areVarsMissing ? `Variables: ${m.vars.join(",")}` : ""}

        Please set defaults in your JSX script (see documentation) or copy the following placeholder JSON code snippet and replace the value with your own:

        ${generatedPlaceholderParameters([...m.fn, ...m.vars])}

        ${showJSXWarning ?
        `Additionally, your JSX script has no initialization of the variables/functions above, which can cause it to crash if executed directly in After Effects.
        Copy and paste the following placeholder code snippet and replace the values with your own:`:'\033[A'}

        ${showJSXWarning ?
        injectionVar : '\033[A'
            }
        `
    }

    /*
        Fill Missing Matches
        ====================
        @description            Creates a placeholder array with all matches within the script 
        @param keys             (Array) Names of the keys to fill the array. Default = [].
        @param placeholder      (Object) Placeholder array to fill values with default value. Default = {}
        @param defaultValue     (Null) Default value to fill objects with. Default = null        
        
        @return                 (Object) placeholder object with names keys set to null.
    */
   const fillObject = (keys = [], placeholder = {}, defaultValue = null) => {
        keys.forEach( v => placeholder[v] = `${defaultValue}`);
        return placeholder;
   };
    
    // Parse all occurrences of the usage of NX on the provided script.
    // const nxMatches = Array.from(script.matchAll(regex)); // String.matchAll is available from Node version 12.0.0
    const nxMatches = script.match(regex); // Backwards compatibility (see above)

    if (nxMatches != null ) {
        // Since the current regex catches ocurrences like NX.call() as `NX.call(` we split the matches as either functions or variables for further debugging.
        for( var i = 0; i < Object.keys(nxMatches).length; i++ ) {

            // var nxMatch = nxMatches[Object.keys(nxMatches)[i]][2]; // String.matchAll is available from Node version 12.0.0
            var nxMatch = nxMatches[i].substr(keyword.length + 1); // Backwards compatibility (see above)

            if ( (nxMatch && parameters.length == 0) || parameters.length > 0 && parameters.filter(o => o.key == nxMatch ).length > 0) { // If there's no parameter object set but there are matches we proceed.
                if(nxMatch.slice(-1) == "(") { // It's a function. 
                    missingMatches.fn.push(nxMatch.replace("(", "")); // Sanitize match.
                } else {
                    missingMatches.vars.push(nxMatch); // It's a variable/object.
                }
            } 
            if( (parameters.filter(o => o.key != nxMatch).length == 0) ) { // If theres a variable on the script but not in the parameters...
                missingMatches.needsDefault.push(nxMatch);  // Set for null filling. 
            }
        }
    }

    // If there's anything that's missing, we proceed with the injection.
    if([...missingMatches.fn, ...missingMatches.vars].length > 0) {
        argumentInjection = setupInjection(keyword, parameters, script, settings.logger);
    }
    
    // Et voilà, winner winner chicken dinner! 
    const compiledScript = `(function() {
        ${argumentInjection}
        ${script}
    })();\n`;

    return (compiledScript)

}

module.exports = (job, settings) => {
    settings.logger.log(`[${job.uid}] running script assemble...`);

    const data = [];
    const base = job.workpath;

    job.assets.map(asset => {
        switch (asset.type) {
            case 'video':
            case 'audio':
            case 'image':
                data.push(wrapFootage(asset));
                break;

            case 'data':
                data.push(wrapData(asset));
                break;

            case 'script':
                data.push(wrapEnhancedScript(asset, job.uid, settings));
                break;
        }
    });

    /* write out assembled custom script file in the workpath */
    job.scriptfile = path.join(base, `nexrender-${job.uid}-script.jsx`);
    fs.writeFileSync(job.scriptfile, script
        .replace('/*COMPOSITION*/', job.template.composition)
        .replace('/*USERSCRIPT*/', data.join('\n'))
    );

    return Promise.resolve(job)
}
