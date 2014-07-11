var connected = [];
var observe_lock = {};
var object_map = {};
var mapping_timer;

Syc = {
  connect: function (socket) { 
    connected.push(socket);
    socket.on('syc-object-change', function (data) { Receive_Object(data, socket)}) 
    Reset(socket);
    
    if (!mapping_timer) mapping_timer = setInterval(Traverse, 6001);
  },
  
  sync: function (name) {
    Verify(this);
    Name(name, this);
  },

  variables: {},
  objects: {}
}

                

/*         Error Handlers        */
function DuplicateNameError (name) { 
  this.value = name;
  this.message = "There is already a syc variable by that name";
  this.toString = function () { return this.value + " " + this.message }
} 

function InvalidTypeError (type) { 
  this.value = type;
  this.message = "Unsupported variable type introduced into this syc object.";
  this.toString = function () { return this.value + " " + this.message }
}


// ---- ---- ---- ----  Helper  ---- ---- ---- ----

function Emit (title, data, sockets) { 
  var audience = sockets || connected;

  audience.forEach( function (socket) { 
    socket.emit(title, data);
  });
}

function Broadcast (title, data, sender) { 
  var audience = connected.slice(0); // create a clone so we don't tamper the original

  audience.splice(audience.indexOf(sender), 1);

  audience.forEach( function (socket) { 
    socket.emit(title, data);
  });
}


function Verify (variable) { 
  if ( !(variable instanceof Syc.sync) )  
    throw "Improper use of Syc.sync(). Try: 'new Syc.sync()'";
}


/* ---- ---- ---- ----  Observing and New Variables  ---- ---- ---- ---- */
function Name (name, variable) { 
  if (name in Syc.variables) throw DuplicateNameError(name);

  Object.defineProperty(variable, 'syc-variable-name', {value: name, enumerable: false});
  id = Meta(variable);

  Syc.variables[name] = id;

  var description = Describe_Recursive(variable);

  Map_Object(variable);

  Emit('syc-variable-new', {name: name, id: id, description: description});
}


function Observed (changes) { 
  for (change in changes) { 
    var object = changes[change].object,
        property = changes[change].name,
        changed = object[property],
        type = Standardize_Change_Type(changes[change].type),
        id = object['syc-object-id'];

    var changes;

    if (id in observe_lock) {
      delete observe_lock[id]; return
    }

    changes = Describe(changed);

    Emit('syc-object-change', { id: id, type: type, property: property, changes: changes });
  }
}

function Standardize_Change_Type (type) { 
  // V8 engine has 'new', 'update', and 'delete, whereas canary uses 'add', 'update'
  if (type === 'updated') return 'update';
  if (type === 'new') return 'add';

  return type;
}

/* ---- ---- ---- ----  Describing and Resolving  ---- ---- ---- ---- */
function Describe (variable) { 
  var type = Type(variable),
      value = Evaluate(type, variable);

  if (Recurrable(type)) { 
    var id = variable['syc-object-id'];

    if (id === undefined) { 
      var properties = {};

      id = Meta(variable);

      for (property in variable) {
        properties[property] = Describe_Untracked(variable[property]);
      }

      Map_Object(variable);

      return {type: type, id: id, properties: properties};
    } else { 
      return {type: type, id: id};
    }
  } else { 
    return {type: type, value: value};
  }
}

// TODO: This is slated to be replaced entirely by the Object Mapping polyfil container. 
function Describe_Recursive (variable, visited) { 
  var type = Type(variable),
      value = Evaluate(type, variable);

  if (Recurrable(type)) { 
    var id = variable['syc-object-id'];

    if (id === undefined) {
      id = Meta(variable);
    }

    if (visited === undefined) var visited = [];
    if (visited.indexOf(id) !== -1) return {type: type, id: id};
    visited.push(id);

    var properties = {};

    for (property in variable) {
      properties[property] = Describe_Recursive(variable[property], visited);
    }

    Map_Object(variable);

    return {type: type, id: id, properties: properties};
  } else { 
    return {type: type, value: value};
  }
}


function Receive_Object (data, socket) { 
  var type     = data.type,
      id       = data.id,
      property = data.property
      changes   = data.changes;

  var variable = Syc.objects[id];

  if (variable === undefined)
    throw "Received changes to an unknown object: " + id;

  observe_lock[id] = true;

  if (type === 'add' || type === 'update') { 
    variable[property] = Apply_Changes(changes);
  } else if (type === 'delete') { 
    delete variable[property];
  } else { 
    throw 'Recieved changes for an unknown change type: ' + type;
  }

  Broadcast('syc-object-change', data, socket);
}

function Apply_Changes (changes) { 
  var type = changes.type,
      variable,
      properties,
      value,
      id; 
   
  if (Recurrable(type)) { 
    properties = changes.properties,
    id         = changes.id;

    if (id in Syc.objects) { 
      return Syc.objects[id];
    } else { 
      if (type === 'object') variable = {};
      if (type === 'array') variable = [];

      id = Meta(variable, id);
      
      for (property in properties) {
        variable[property] = Apply_Changes(properties[property])
      }

      Map_Object(variable);

      return variable;
    }
  } else { 
    value = changes.value;
    return Evaluate(type, value);
  }
}


// ---- ---- ---- ----  Object Conversion  ----- ---- ---- ---- 
function Meta (variable, id) {
  if (variable['syc-object-id']) { throw "Already Existing object" };

  var id = id || token();
  Object.defineProperty(variable, 'syc-object-id', {value: id, enumerable: false});

  Syc.objects[id] = variable;

  if (Object.observe) Object.observe(variable, Observed);
  
  function token () { 
    // TODO: There's a small offchance that two separate clients could create an object with the same token before it's registered by the server.
    function rand () { return Math.random().toString(36).substr(2) }
    var toke = rand() + rand();
    if (toke in Syc.objects) return token();
    else return toke;
  }

  return id;
}

function Type (obj) { 
  return ({}).toString.call(obj).match(/\s([a-zA-Z]+)/)[1].toLowerCase()
}

function Evaluate (type, value) { 
  if (type === 'string')   return value;
  if (type === 'number')   return Number(value);
  if (type === 'boolean')  return value === 'true';
  if (type === 'date')     return JSON.parse(value);
  if (type === 'regexp')   return new RegExp(value);

  if (Recurrable(type)) {
    return Syc.objects[value];
  }

  if (type === 'undefined') return undefined;

  throw 'Object type ' + type + ' not supported by syc';
}

function Recurrable (type) {
  return (type === 'array' || type === 'object');
}


// ---- ---- ---- ----  Requests  ---- ---- ---- ----

function Reset (socket) { 
  var described = {};

  for (name in Syc.variables) {
    var id = Syc.variables[name],
        variable = Syc.objects[id];

    Emit('syc-variable-new', {name: name, id: id, description: Describe_Recursive(variable)}, [socket]);
  }
}


// ---- ---- ---- ----  Polyfill  ---- ---- ---- ---- 
// ---- ---- ---- ----  Garbage Collection ---- ---- ---- ---- 
// Map_Object should come after a call to Meta for the variable in question, and
// after a recursive describe/resolve (so as to ensure Map_Object's properties all
// have syc-object-id).
Map_Object = function (variable) { 
  var id = variable['syc-object-id'];

  object_map[id] = []; // Reset the mapping

  for (property in variable) { 
    var type = Type(variable[property]),
        value = Evaluate(type, variable[property]);

    object_map[id][property] = {type: type, value: value};
  }
}

var visited = {};

function Traverse () { 
  for (obj in Syc.objects) { 
    visited[obj] = false;
  }

  // Start the recursion
  for (id in Syc.variables) { 
    Map(Syc.objects[Syc.variables[id]]);
  }

  // Mark Sweep algorithm for garbage collection (if unvisited, garbage collect)
  for (obj in visited) { 
    if (!(visited[obj])) { 
      delete Syc.objects[obj];
    }
  }
}

function Map (variable) {
  var id = variable['syc-object-id'];

  if (id === undefined) throw 'Sanity Check: polyfill cannot determine object id';

  var proceed = Per_Variable(variable, id);

  if (proceed) { 
    for (property in variable) {
      var recur = Per_Property(variable, property, id);

      if (recur) { 
        Map(variable[property]);
      }
    }
  }

  Map_Object(variable);
}

function Per_Variable (variable, id) { 
  if (id in visited) { 
    if (visited[id]) return false;
    else visited[id] = true;
  } else {
    throw "Sanity check: id " + id + " not given a mark for garbage collection." 
  }

  var map = object_map[id];

  for (property in map) {
    if (!(property in variable)) { 
      Observer(property, variable, 'delete', map[property]);
    }
  }

  return true;
}

function Per_Property (variable, name, variable_id) { 
  var property = variable[name],
      type = Type(property),
      value = Evaluate(type, property);

  var map = object_map[variable_id][name];

  if (map === undefined) {
    Observer(name, variable, 'add');
  }

  else if (map.type !== type) { 
    Observer(name, variable, 'update', map);
  }

  else if (type === 'array' || type === 'object') { 
    var property_id = property['syc-object-id'];

    if (property_id === undefined) {
      Observer(name, variable, 'update ', map);
      return false; // Map doesn't need to recur over untracked objects/arrays (Those are handled by Observed)
    }

    else if (map.value !== property_id) { 
      Observer(name, variable, 'update', map);
    }

    return true;

  } else if (map.value !== value) { 
    Observer(name, variable, 'update', map.value);
  }
 
  return false; 
}

function Observer (name, object, type, old_value) { 
  var changes = {name: name, object: object, type: type};

  if (old_value) { 
    if (old_value.type === 'array' || old_value.type === 'object') { 
      if (old_value.value in Syc.objects) { 
        changes.old_value = Syc.objects[old_value.value];
      }
    } else {
      changes.old_value = old_value;
    }
  }

  Observed([changes]);
}





module.exports = Syc;

