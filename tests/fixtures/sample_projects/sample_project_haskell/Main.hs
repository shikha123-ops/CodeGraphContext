module Main where

hello :: String -> IO ()
hello name = putStrLn ("Hello, " ++ name)

data Person = Person { name :: String, age :: Int }

main :: IO ()
main = hello "World"
