using System;
using System.Collections.Generic;
using Util = MyApp.Utilities;

namespace MyApp.Services
{
    public interface IService { void Run(); }

    public class UserService : BaseService, IService
    {
        private readonly List<string> _names = new();
        public int Count { get; set; }

        public UserService(int count) { Count = count; }

        public void Run() => Console.WriteLine("run");

        public async Task<List<string>> LoadAsync(string path, int limit = 10)
        {
            var result = new List<string>();
            if (path == null)
            {
                throw new ArgumentNullException(nameof(path));
            }
            else if (path.Length == 0)
            {
                return result;
            }
            for (int i = 0; i < limit; i++)
            {
                if (i % 2 == 0) continue;
                result.Add(i.ToString());
                if (result.Count > 5) break;
            }
            foreach (var name in _names)
            {
                Log(name);
            }
            try
            {
                Validate(result);
            }
            catch (InvalidOperationException ex)
            {
                Log(ex.Message);
            }
            finally
            {
                Count = Math.Max(Count, result.Count);
            }
            switch (limit)
            {
                case 1:
                    Log("one");
                    break;
                case 2:
                case 3:
                    Log("few");
                    break;
                default:
                    Log("many");
                    break;
            }
            Func<int, int> f = x => x + 1;
            return result;
        }

        private static void Log(string s) => Console.WriteLine(s);
        private void Validate(List<string> xs) { }
    }

    public struct Point { public int X; public int Y; }
    public enum Mode { A, B }
}
