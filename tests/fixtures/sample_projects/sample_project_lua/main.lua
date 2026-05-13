local function greet(name)
    print("Hello, " .. name)
end

Rectangle = {}
function Rectangle:new(w, h)
    local obj = {width = w, height = h}
    setmetatable(obj, self)
    self.__index = self
    return obj
end

local r = Rectangle:new(10, 20)
greet("CGC")
